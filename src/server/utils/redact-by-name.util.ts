/**
 * Name-based recursive redaction.
 *
 * Layer: server/utils — the engine behind the library's DEFAULT PII protection.
 * It walks a log record once and censors every value whose KEY NAME is in the
 * sensitive set, to a bounded depth (see {@link REDACT_MAX_TRAVERSAL_DEPTH}).
 *
 * Why this replaced path matching. The previous default compiled 140
 * `fast-redact` paths, 108 of them multi-level wildcards (`*.password`,
 * `*.*.password`, …). `fast-redact` walks every key at every listed level on
 * every log call, so the cost grew with the PATH COUNT, not with the payload:
 * measured at ~107 µs per entry (≈9.3 k logs/s) against ~0.9 µs with redaction
 * off. A single traversal is O(nodes) — the same order Pino's serializer already
 * pays. The shipped configuration measures 462 k logs/s against 9.3 k, for
 * byte-identical output on every payload the old paths covered.
 *
 * It is also STRICTLY SAFER than the paths it replaces:
 *   - depth 100 instead of four, and past it the value is DROPPED rather than
 *     passed through, so the ceiling cannot become a leak the way the old one
 *     was (anything below the wildcard list's fourth level was emitted in clear);
 *   - a sensitive key is caught wherever it appears, so a headers bag logged as
 *     `{ headers: { authorization } }` is covered, not only the exact
 *     `req.headers.authorization` shape the absolute paths pinned.
 *
 * Three value kinds need special handling, and getting any of them wrong is a
 * leak rather than a cosmetic issue:
 *   - `Error` — copied through its prototype and descriptors, so it stays an
 *     `Error` (Pino's `err` serializer keys off the instance, and `message` /
 *     `stack` are own but NON-enumerable). Skipping errors entirely left an
 *     error under any key WITHOUT a serializer serializing its own enumerable
 *     properties in clear.
 *   - anything carrying `toJSON` (`Date`, `Decimal`, Luxon, Prisma types) — the
 *     method decides the serialized form, so the walk inspects its OUTPUT.
 *     Skipping these let a `toJSON` SYNTHESIZE a secret straight past both hooks.
 *   - `ArrayBuffer` views (`Buffer`, typed arrays) — indexed byte containers,
 *     returned untouched.
 *
 * What this file cannot reach: bindings passed to `child()`. Pino pre-serializes
 * them into the instance's `chindings` fragment before any formatter runs, so
 * `PinoLoggerService.child()` applies this redactor itself.
 *
 * Contract: SNAPSHOT and NEVER-THROW. Nothing the caller passed is mutated; the
 * result is a fresh structure built from values read exactly ONCE. That is a
 * deliberate trade against an earlier copy-on-write design which returned a
 * clean subtree by reference: doing so left every accessor in it to be evaluated
 * a SECOND time by `JSON.stringify`, and a stateful getter (or `toJSON`) can
 * answer clean to the walk and `{ password }` to the serializer. Inspection
 * cannot close that window — only reading once and pinning the result can. It
 * costs ~26 % of the entry throughput, measured, and the walk is still ~36x
 * faster than the path expansion it replaced.
 *
 * Any internal failure — a throwing getter, a hostile proxy, a value the walk
 * cannot READ — degrades the whole record to a marked, secret-free envelope rather
 * than crashing the request that produced it. Writing the censor is not among those
 * failures: every copy is built so the write cannot fail, which is why a frozen
 * error keeps its fields instead of costing the record.
 *
 * @see {@link createNameRedactor}
 */
import { cutIfText } from './bounded-text.util'
import { ALL_OWN_FIELDS, type OwnFieldPolicy } from './own-field-policy.util'
import {
  addErrorParts,
  defineOwn,
  ERROR_TEXT_FIELDS,
  readOwnField,
  type ErrorPartsHost
} from './redact-error-parts.util'
import { OMIT_OWN_FIELD, ownFieldForLog, sanitizeError } from './sanitize-error.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

/**
 * Traversal ceiling. Not a redaction ceiling in any realistic sense — real log
 * payloads are single-digit-deep, and the value it replaced was FOUR — but an
 * unbounded recursion over a pathological (or hostile) self-similar structure
 * would exhaust the call stack, and a logging concern must never crash its
 * caller. Past this depth a CONTAINER is dropped, NOT passed through: it is what
 * could hide an uninspected sensitive key, and failing closed is the only safe
 * direction for a redactor.
 *
 * A PRIMITIVE sitting exactly at the boundary is still emitted, and that is
 * deliberate rather than a gap in the ceiling: its key was compared against the
 * sensitive set by its parent — the last container the walk inspected — so it has
 * already been through the matcher. Dropping it would destroy legitimate leaf
 * data and buy no protection. The ceiling exists to bound RECURSION, and only a
 * container recurses.
 */
export const REDACT_MAX_TRAVERSAL_DEPTH = 100

/** Substituted for a value nested deeper than {@link REDACT_MAX_TRAVERSAL_DEPTH}. */
export const REDACT_DEPTH_EXCEEDED = '[REDACTION_DEPTH_EXCEEDED]'

/**
 * Containers one redaction call visits before it stops expanding. The walk expands an object once
 * per path that reaches it, so a graph that shares references grows as 2^depth in time and in
 * output; this bounds both. A call that reaches it fills every further container with
 * {@link REDACT_BUDGET_EXCEEDED}, keeps only the primitives beside them, and passes nothing through
 * unwalked. Measured, 200000 visits walk in about 100 to 150 ms.
 */
export const REDACT_MAX_VISITS = 200_000

/** Substituted for a container met after {@link REDACT_MAX_VISITS} containers were visited. */
export const REDACT_BUDGET_EXCEEDED = '[REDACTION_BUDGET_EXCEEDED]'

/**
 * Substituted for a reference already on the current traversal path.
 *
 * Matches the sentinel Pino's own stringifier emits for a cycle, so a circular
 * record serializes the same as it did before this engine existed. The ORIGINAL
 * reference is deliberately NOT returned in its place: a copied ancestor carries
 * censored values while the original still holds the raw ones, so handing the
 * original back would re-expose through the cycle exactly what was just redacted.
 */
export const REDACT_CIRCULAR = '[Circular]'

/**
 * Envelope substituted for a whole record whose traversal threw — a hostile
 * getter, a proxy that rejects reads, an exotic host object. Carries no data
 * from the record: if the record could not be walked, it could not be proven
 * safe.
 */
export interface RedactionFailedEnvelope {
  /** Always `true` — marks the record as unredactable. */
  _redactionFailed: true
  /** Reserved log key so aggregators can detect and alert on the condition. */
  _logKey: typeof RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
}

/** A `toJSON` resolved off a value, and how it was stored. */
interface ResolvedToJson {
  /** The callable method, or `undefined` when the value has none. */
  method: (() => unknown) | undefined
  /**
   * `true` when `toJSON` is an ACCESSOR, so a second read can yield a different
   * function. Nothing may be decided from the identity of such a method.
   */
  fromAccessor: boolean
}

/**
 * Resolve `toJSON` along the prototype chain, reading it exactly ONCE and
 * reporting whether it came from an accessor. A plain `value.toJSON` read gave
 * neither, and both matter.
 *
 * Reading once is the design's premise — the walk used to read the property
 * twice, invoking a getter twice per value. Reporting the accessor case closes a
 * live leak: a getter answers differently on every read, so identity says nothing
 * about what `JSON.stringify` reads later, and an accessor returning
 * `Buffer.prototype.toJSON` took the fast path that hands back the ORIGINAL
 * object — the stringifier then read a `{ password }` factory from it.
 *
 * @param value - A non-null object.
 * @returns The resolved method and whether it came from an accessor.
 */
function resolveToJson(value: object): ResolvedToJson {
  let getter: (() => unknown) | undefined
  let candidate: unknown
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON')
    if (descriptor !== undefined) {
      getter = descriptor.get
      candidate = getter === undefined ? descriptor.value : getter.call(value)
      break
    }
    current = Object.getPrototypeOf(current)
  }
  // One exit, deliberately. A separate `{ method: undefined, fromAccessor: false }`
  // for the no-`toJSON` case carried a boolean nothing reads — the flag is only
  // ever consulted alongside a method — so it was an equivalent mutant by
  // construction. Falling through with both locals unset says the same thing
  // without the dead literal.
  return {
    method: typeof candidate === 'function' ? (candidate as () => unknown) : undefined,
    fromAccessor: getter !== undefined
  }
}

/**
 * Clone an `Error` preserving what makes it an Error.
 *
 * The walk cannot flatten an error into a plain object: Pino's `err` serializer
 * keys off the instance, and `message` / `stack` are own but NON-enumerable, so
 * a spread would silently drop them. Copying the prototype and the full
 * descriptor set keeps `instanceof`, the message and the stack intact while the
 * caller redefines the enumerable properties it censored.
 *
 * @param error - The error to clone.
 * @returns A structurally identical error with its own descriptors copied.
 */
function cloneError(error: Error): Error {
  // Descriptors are copied for their SHAPE, not their immutability. A consumer
  // that freezes its errors — a deliberate, documented practice, so nobody mutates
  // an issue list after the throw — hands us properties that are neither writable
  // nor configurable, and the clone inherited that. Every own enumerable key is
  // then rewritten below with its walked value, and redefining a non-configurable
  // property fails whenever that value is a fresh object rather than the original
  // reference: a censored secret, or simply the structural copy the walk makes of
  // a nested array. The failure used to reach the caller's guard and drop the
  // WHOLE record, so a frozen error carrying an array lost every field including
  // its own message — total silent loss of the one thing worth logging.
  //
  // The clone is transient: built here, serialized, discarded. Nothing downstream
  // reads its descriptors, so relaxing them changes only whether this function can
  // finish its job. Freezing is the CALLER's guarantee about the CALLER's object,
  // which is untouched either way.
  // `configurable` alone: `Reflect.defineProperty` redefines a configurable property
  // whatever its `writable` flag says, and nothing here ever ASSIGNS to the clone.
  // Relaxing `writable` too was in the first version of this fix and mutation testing
  // showed it — four surviving mutants on that line, because no input can tell the
  // difference.
  const descriptors = Object.getOwnPropertyDescriptors(error)
  for (const descriptor of Object.values(descriptors)) {
    descriptor.configurable = true
  }
  const clone = Object.create(Object.getPrototypeOf(error) as object, descriptors) as Error
  // V8 exposes `stack` as an own ACCESSOR bound to the original error's internal
  // state, so copying the descriptor hands the clone a getter that resolves to a
  // near-empty string. Pin the already-resolved trace as a plain data property —
  // without this the redacted error reaches the sink with its stack erased,
  // which is worse than the leak the clone exists to close.
  const { stack } = error
  if (typeof stack === 'string') {
    // `enumerable: false` matches how a real Error carries its stack — making it
    // enumerable would push the whole trace into `JSON.stringify` output for every
    // redacted error. `writable` / `configurable` are left at their `false`
    // defaults: nothing downstream rewrites or deletes a stack.
    Reflect.defineProperty(clone, 'stack', { value: stack, enumerable: false })
  }
  // The clone is handed on after the walk has read `toJSON` once, and a descriptor copied from the
  // source (an accessor that answers differently the next time) or one inherited would let
  // `JSON.stringify` run a hook the walk never saw. An own `undefined` shadows both.
  Reflect.defineProperty(clone, 'toJSON', { value: undefined, configurable: true })
  return clone
}

/**
 * A callable, handed on as one that has no `toJSON`. `JSON.stringify` reads `toJSON` of a function
 * too, through whatever the value is (an accessor, a prototype, a Proxy trap), and the walk cannot
 * tell by any one read of its own what that will answer, so no function is handed on as it is.
 */
function withoutToJson(callable: CallableFunction): (...args: unknown[]) => unknown {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(callable, this, args)
  }
  Reflect.defineProperty(wrapped, 'toJSON', { value: undefined })
  return wrapped
}

/**
 * A configured redactor.
 *
 * @param value - The value to redact.
 * @param isRecordRoot - `true` when `value` is the ROOT of a log record — the
 *   object Pino iterates rather than serializes. A root must not honour a
 *   `toJSON` method, because doing so would replace the entire record with that
 *   method's return value; nested values and serializer outputs do reach
 *   `JSON.stringify` and keep it.
 */
export type Redactor = (value: unknown, isRecordRoot?: boolean) => unknown

/**
 * `Buffer.prototype.toJSON`, captured once for an identity comparison.
 *
 * Held as a reference rather than re-read per call so the fast-path check is a
 * pointer compare, and so a later reassignment of the global cannot redirect it.
 */
const BUFFER_TO_JSON: unknown = Buffer.prototype.toJSON

/** What one walk needs besides the value. */
interface RedactRules {
  /** Lower-cased field names whose values are censored. */
  readonly sensitive: ReadonlySet<string>
  /** Replacement written in place of a sensitive value. */
  readonly censor: string
  /** Record-root keys that have a serializer: what sits under them is read as it is. */
  readonly serializedKeys: ReadonlySet<string>
  /** Whether an `Error` outside those keys is written as data; off, it stays an `Error`. */
  readonly errorsAsData: boolean
  /** Containers one call may visit before it stops expanding. */
  readonly maxVisits: number
  /** Which own fields of an `Error` are written. */
  readonly ownFields: OwnFieldPolicy
  /** Containers this call has visited, counted against {@link RedactRules.maxVisits}. */
  readonly visits: { count: number }
}

/**
 * Copy-on-write walk of an array's elements. Split out of {@link walk} to keep
 * both bodies within the project's nesting limit.
 *
 * @param value - The array to inspect.
 * @param rules - The names to censor and the root keys that have a serializer.
 * @param depth - Depth of `value` itself; elements are one deeper.
 * @param ancestors - References on the current path (cycle guard).
 * @returns The array itself when no element changed, otherwise a copy.
 */
function walkArray(
  value: readonly unknown[],
  rules: RedactRules,
  depth: number,
  ancestors: Set<object>,
  inSerialized: boolean
): unknown[] {
  // Indexed by NUMBER, not iterated. `for...of` runs the array's
  // `Symbol.iterator`, which a caller can override — whereas `JSON.stringify`
  // reads `length` and numeric indices. An overridden iterator that never
  // returns `done` would hang the log call (the try/catch cannot catch a loop
  // that does not end), and one that yields values unrelated to the indices
  // would make the walk inspect something other than what the array holds.
  // Reading the way the serializer reads removes both. `length` is read once and
  // is a plain data property: `Array.isArray` guarantees a real array.
  const length = value.length
  // Not pre-sized with `new Array(length)`: the loop writes every index anyway,
  // so the size hint buys nothing — and it would create a HOLEY array, which V8
  // handles more slowly than the packed one that sequential writes produce.
  const copy: unknown[] = []
  for (let index = 0; index < length; index++) {
    // `Reflect` keeps the dynamic read/write off the object-injection sink list.
    Reflect.set(
      copy,
      index,
      walk(Reflect.get(value, index), rules, depth + 1, ancestors, true, inSerialized)
    )
  }
  return copy
}

/**
 * Recursive snapshotting walk. Every value is read exactly once and pinned into
 * a fresh structure, so the result is guaranteed to equal what was inspected.
 *
 * @param value - The value to inspect.
 * @param rules - The names to censor and the root keys that have a serializer.
 * @param depth - Current depth, against {@link REDACT_MAX_TRAVERSAL_DEPTH}.
 * @param ancestors - References on the current path (cycle guard).
 * @returns The value, or a redacted copy of it.
 */
function walk(
  value: unknown,
  rules: RedactRules,
  depth: number,
  ancestors: Set<object>,
  honorToJson = true,
  inSerialized = false
): unknown {
  // Callables are admitted, not skipped as primitives. `JSON.stringify` invokes a
  // callable `toJSON` on a FUNCTION object too — it applies that step before the
  // "callable serializes to undefined" rule — so
  // `Object.assign(() => {}, { toJSON: () => ({ accessToken }) })` emitted the
  // token with nothing having inspected it. A function WITHOUT `toJSON` is
  // returned untouched below, so it keeps being omitted from the output.
  if (value === null) {
    return value
  }
  // `typeof` is written inline rather than hoisted into a variable so TypeScript
  // narrows `value` from `unknown` for the rest of the function.
  if (typeof value !== 'object' && typeof value !== 'function') {
    return value
  }
  if (depth > REDACT_MAX_TRAVERSAL_DEPTH) {
    return REDACT_DEPTH_EXCEEDED
  }
  if (++rules.visits.count > rules.maxVisits) {
    return REDACT_BUDGET_EXCEEDED
  }
  if (ancestors.has(value)) {
    return REDACT_CIRCULAR
  }
  // An Error is the one value whose unreadable parts are isolated: it degrades on its own and
  // its siblings survive. See `walkError`.
  if (value instanceof Error) {
    return walkError(value, rules, depth, ancestors, honorToJson, inSerialized)
  }
  return walkObject(value, rules, depth, ancestors, honorToJson, inSerialized)
}

/**
 * Walk an `Error`, degrading it alone when it cannot be read.
 *
 * `formatters.log` runs BEFORE the `err` serializer, so this walk is the first code to touch
 * a raw `Error`. An `Error` whose own keys, getters, `stack` or `toJSON` throw must degrade
 * on its own and leave the record's `logKey`, `userId` and metadata intact: the record-level
 * `LOGGER_REDACTION_FAILED` envelope is reserved for a hostile RECORD, whose siblings cannot
 * be vouched for, and an unreadable `Error` is not one, because its siblings were each read
 * and walked fine. So the node is replaced by `sanitizeError` of it, which never throws, copies no field it could
 * not read and marks what it lost, and THAT node goes through the walk again: a field the
 * sanitizer could still copy is censored by name like any other, and a field it could not
 * read is never copied. A hostile value that is not an `Error` is not isolated and still
 * fails the whole record.
 *
 * @param error - The error to walk.
 * @param rules - The names to censor and the root keys that have a serializer.
 * @param depth - Current depth, against {@link REDACT_MAX_TRAVERSAL_DEPTH}.
 * @param ancestors - References on the current path (cycle guard).
 * @param honorToJson - `false` only for the root of a log record.
 * @returns The redacted error, or the redacted sanitized node when it could not be read.
 */
function walkError(
  error: Error,
  rules: RedactRules,
  depth: number,
  ancestors: Set<object>,
  honorToJson: boolean,
  inSerialized: boolean
): unknown {
  try {
    return walkObject(error, rules, depth, ancestors, honorToJson, inSerialized)
  } catch {
    // The sanitized node replaces an `Error` that cannot be read: it never throws, copies no
    // field it could not read and marks what it lost. Under a serialized key the same node is
    // what the serializer receives.
    // The sanitized node is the same container as `error`, which `walk` already counted.
    rules.visits.count--
    return walk(
      sanitizeError(error, { ownFields: rules.ownFields }),
      rules,
      depth,
      ancestors,
      honorToJson,
      inSerialized
    )
  }
}

/**
 * The inspection of an object or callable that is not an `Error`, or an `Error` that reads
 * cleanly: the body of {@link walk} after its guards.
 *
 * @param value - The value to inspect.
 * @param rules - The names to censor and the root keys that have a serializer.
 * @param depth - Current depth, against {@link REDACT_MAX_TRAVERSAL_DEPTH}.
 * @param ancestors - References on the current path (cycle guard).
 * @param honorToJson - `false` only for the root of a log record.
 * @returns The value, or a redacted copy of it.
 */
function walkObject(
  value: object,
  rules: RedactRules,
  depth: number,
  ancestors: Set<object>,
  honorToJson: boolean,
  inSerialized: boolean
): unknown {
  // `ArrayBuffer` views (`Buffer`, typed arrays) are indexed byte containers: a
  // key-name match is meaningless and a copy would be enormous. Checked BEFORE
  // `toJSON` because `Buffer` has one.
  // The ONE fast path for binary data, and it is an identity check rather than a
  // shape test. Every looser formulation leaked:
  //   - `ArrayBuffer.isView(value)` alone also matched extended views — an own
  //     `toJSON` synthesizing a payload, or an enumerable property on a
  //     `Uint8Array` / `DataView`, neither of which has a `toJSON` to hide it
  //     (`JSON.stringify(new Uint8Array([1]))` is `{"0":1}`, so a custom key
  //     lands right beside the indices);
  //   - adding "and no OWN `toJSON`" still admitted a SUBCLASS that defines one
  //     on its own prototype, e.g. `class V extends Uint8Array { toJSON() {…} }`.
  // Only `Buffer.prototype.toJSON` ITSELF is known to produce a canonical
  // `{ type, data }` that cannot carry a caller's key, so that exact function is
  // what the check accepts. It is worth keeping: walking a binary payload
  // recurses over every byte and copies the lot. Anything else — including any
  // subclass that overrides it — falls through and is inspected.
  // Resolved ONCE for both the fast path and the `toJSON` branch below: every
  // extra read is another chance for an accessor to answer differently.
  // `fromAccessor` disqualifies the fast path even when the method IS
  // `Buffer.prototype.toJSON`, because this path hands back the ORIGINAL
  // reference and `JSON.stringify` reads `toJSON` again from it.
  const resolvedToJson = resolveToJson(value)
  if (!resolvedToJson.fromAccessor && resolvedToJson.method === BUFFER_TO_JSON) {
    return value
  }

  ancestors.add(value)
  try {
    // `toJSON` is checked BEFORE the array branch, because `JSON.stringify` gives
    // the method precedence over array serialization too — an `Array` subclass
    // with a `toJSON()` that returns `{ accessToken }` would otherwise be walked
    // as an ordinary array (finding nothing) and then emit the token in clear.
    //
    // A value with `toJSON` decides its own serialized form, so walking its own
    // properties would inspect something that never reaches the log — while
    // skipping it entirely leaves whatever the method SYNTHESIZES unredacted.
    // Walk the method's output instead, and substitute it only when something was
    // actually censored: a clean `Date` / `Decimal` / Luxon value is returned by
    // reference, so serializers downstream still receive the original object.
    // `honorToJson` is false for exactly one caller: the ROOT of a log record.
    // Pino ITERATES that object — it never calls `toJSON` on it — so honouring the
    // method there would replace the whole record with the method's return value
    // and discard `logKey`, `msg` and every other field. Nested values and
    // serializer outputs DO reach `JSON.stringify`, which honours `toJSON`, so
    // they keep it.
    // Under `errorOwnFields: 'safe'` an `Error` written as data is written from its own fields: a
    // library's `toJSON` (an HTTP client's, say) would otherwise carry the request it made. Any
    // other `Error` stays an instance that keeps its `toJSON`, so the method is still walked and
    // replaced by its censored output. What the walk hands on never holds a hook to run later: a
    // clone and a function are given a `toJSON` of `undefined`, and `defineOwn` refuses a callable.
    const ownsItsForm = rules.ownFields.safe && isWrittenAsData(value, rules, inSerialized)
    const toJson = honorToJson && !ownsItsForm ? resolvedToJson.method : undefined
    if (toJson !== undefined) {
      // A `toJSON` can RENAME the field it exposes, carrying the value around the
      // matcher: `{ password, toJSON() { return { value: this.password } } }`
      // emitted the secret under `value`, because only the OUTPUT is walked and
      // the source key `password` is never seen. So when the SOURCE itself
      // carries a sensitive own key, the method is not trusted to preserve it and
      // the whole value is censored — fail closed.
      //
      // The obvious alternative, calling `toJSON` against a sanitized copy, was
      // rejected: it breaks every method that reads an internal slot rather than
      // an own property. `Date.prototype.toJSON.call({ ...new Date() })` throws
      // `toISOString is not a function`, and `Decimal` / Luxon behave the same —
      // that would trade a narrow leak for a crash on the COMMON case.
      //
      // `Object.keys` reads names only; no getter is invoked, so the source is
      // not observed twice. The check is shallow by design: a method that reaches
      // into NESTED state (`this.inner.password`) to rename it is not caught, and
      // cannot be — that is the same limitation as a caller writing
      // `{ renamed: obj.inner.password }` by hand, which no name matcher sees.
      // Documented in PINO-REDACTION-GUIDELINES.md under the engine's limits.
      if (Object.keys(value).some((key) => rules.sensitive.has(key.toLowerCase()))) {
        return rules.censor
      }
      // The INSPECTED result is what gets returned, always — never the original
      // object. Returning the original when the probe came back clean left
      // `JSON.stringify` to call `toJSON()` a SECOND time (with the property key,
      // which this call does not pass), so a stateful or key-dependent method
      // could answer clean here and `{ password }` at serialization. The cost is
      // that a clean `Date` / `Decimal` is substituted by its serialized form
      // rather than passed through by reference; the JSON output is identical,
      // and determinism is worth more than the reference.
      // `depth + 1`: following the output is a recursive step like any other.
      // Leaving the counter let a chain of methods each returning a FRESH
      // `toJSON`-bearing object recurse forever — nothing repeats, so the ancestor
      // set never matches and the ceiling was never reached. The stack exhausted
      // instead: contained by the root catch, but at the cost of the WHOLE record.
      return walk(toJson.call(value), rules, depth + 1, ancestors, true, inSerialized)
    }

    // A callable with no `toJSON` reaches here. It must be handed back as-is:
    // walking it would replace it with a plain object, and `JSON.stringify`
    // omits a bare function rather than emitting `{}`.
    if (typeof value === 'function') {
      return withoutToJson(value as CallableFunction)
    }

    if (Array.isArray(value)) {
      return walkArray(value, rules, depth, ancestors, inSerialized)
    }

    // No `toJSON` decides its form (that branch returned), and `JSON.stringify` writes `{}`.
    const source = value as Record<string, unknown>
    // No fast path for an empty key list. Returning the original would reopen the
    // very window the snapshot closes: a Proxy can answer `[]` to this
    // `Object.keys` and expose an enumerable `password` when Pino serializes the
    // reference afterwards. An empty object costs one allocation; the alternative
    // costs the guarantee.
    const keys = Object.keys(source)

    // Every property is SNAPSHOT into a fresh object, even when nothing was
    // censored. Returning a clean subtree by reference was the allocation-free
    // fast path, but it left any accessor in that subtree to be evaluated a
    // SECOND time by `JSON.stringify` — and a stateful getter can answer `{}` to
    // the walk and `{ password }` to the serializer. Reading each value once and
    // pinning it as a data property removes that window by construction, which
    // no amount of inspection could.
    //
    // The copy is built from the values already read rather than by spreading
    // `source`: a spread would re-invoke every getter, reopening the same window.
    // An Error is cloned through its prototype and descriptors so it stays an
    // Error; anything else becomes a plain object carrying the same own
    // enumerable properties — exactly what `JSON.stringify` would have emitted.
    // Outside a serializer's keys an `Error` is written as data: its own fields below plus the
    // head and chain, which are only ever added.
    const asData = isWrittenAsData(value, rules, inSerialized)
    // The clone is made even when discarded: an `Error` it cannot read must reach the fallback in
    // `walkError`, which is the same node with or without the data form.
    const clone = value instanceof Error ? cloneError(value) : undefined
    const copy = clone !== undefined && !asData ? (clone as unknown as Record<string, unknown>) : {}
    // What a failed driver call quoted or was given is not written, whether the `Error` is written
    // as data or kept an instance: it can sit in the serializer's output as a field of the root
    // `err` (a driver error held by a wrapper), or be returned by a custom serializer. Under a
    // serializer's key the instance is the serializer's to read, so nothing is dropped there.
    const scrubbed = value instanceof Error && !inSerialized
    const omitted = new Set<string>()
    for (const key of keys) {
      // Under a serializer's key the field is the serializer's to read, but a binary one is still
      // written as its size: the copy handed on would otherwise hold it as an object of indexes.
      const current = scrubbed
        ? ownFieldForLog(source, key, Reflect.get(source, key), rules.ownFields)
        : readOwnField(source, key)
      if (current === OMIT_OWN_FIELD) {
        // The clone carries the original field; the data form has none to remove.
        Reflect.deleteProperty(copy, key)
        omitted.add(key)
        continue
      }
      defineOwn(
        copy,
        key,
        rules.sensitive.has(key.toLowerCase())
          ? rules.censor
          : walk(
              // An own enumerable `name`, `message` or `stack` of an `Error` is the same text as
              // the part the walk would add, so it is cut the same way.
              scrubbed && ERROR_TEXT_FIELDS.has(key) ? cutIfText(current) : current,
              rules,
              depth + 1,
              ancestors,
              true,
              inSerialized || (!honorToJson && rules.serializedKeys.has(key))
            )
      )
    }
    if (asData) {
      const written = keys.filter((key) => !omitted.has(key))
      addErrorParts(copy, value as Error, written, errorPartsHost(rules, ancestors), depth)
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}

/** Whether an `Error` is written as data (its own fields plus the parts added), not kept as an instance. */
function isWrittenAsData(value: object, rules: RedactRules, inSerialized: boolean): boolean {
  return value instanceof Error && rules.errorsAsData && !inSerialized
}

/** What the code that writes the parts of an `Error` needs from this walk. */
function errorPartsHost(rules: RedactRules, ancestors: Set<object>): ErrorPartsHost {
  return {
    sensitive: rules.sensitive,
    censor: rules.censor,
    walk: (value, depth) => walk(value, rules, depth, ancestors),
    hasToJson: (value) => resolveToJson(value).method !== undefined
  }
}

/**
 * Build a redactor that censors every value whose key name is in `fieldNames`,
 * to {@link REDACT_MAX_TRAVERSAL_DEPTH}, in a single snapshotting traversal.
 *
 * @param fieldNames - Sensitive field names, matched case-INSENSITIVELY so a
 *   header bag carrying `Authorization` is covered as well as `authorization`.
 *   Matching applies down to {@link REDACT_MAX_TRAVERSAL_DEPTH}; a container
 *   deeper than that is dropped rather than emitted, while a primitive leaf at
 *   the boundary is kept — its key was already matched one level up.
 * @param censor - Replacement written in place of a sensitive value.
 * @param serializedKeys - Record-root keys that have a serializer; given, an `Error` outside them
 *   is written as data.
 * @param maxVisits - Containers one call may visit; a seam for tests, which exercise the boundary
 *   with a small number. The package passes none.
 * @param ownFields - Which own fields of an `Error` written as data are kept; all by default.
 * @returns A pure function mapping a value to its redacted equivalent.
 * @example
 *   const redact = createNameRedactor(['password'], '[REDACTED]')
 *   redact({ user: { deep: { password: 's' } } })
 *   // → { user: { deep: { password: '[REDACTED]' } } }
 */
export function createNameRedactor(
  fieldNames: Iterable<string>,
  censor: string,
  serializedKeys?: readonly string[],
  maxVisits: number = REDACT_MAX_VISITS,
  ownFields: OwnFieldPolicy = ALL_OWN_FIELDS
): Redactor {
  // Matched case-INSENSITIVELY. HTTP header names are case-insensitive by spec,
  // and only INBOUND Node headers arrive lower-cased — a hand-built or outbound
  // bag routinely carries `Authorization`, `Cookie`, `X-API-Key`, which a
  // case-sensitive set left in clear despite the documented header coverage.
  // Applying it to every name rather than only to headers costs one
  // `toLowerCase()` per key (~4 % of an entry, measured) and errs toward
  // redacting `Password` / `Email` too, which is the safe direction.
  const rules: Omit<RedactRules, 'visits'> = {
    sensitive: new Set(Array.from(fieldNames, (name) => name.toLowerCase())),
    censor,
    serializedKeys: new Set(serializedKeys),
    errorsAsData: serializedKeys !== undefined,
    maxVisits,
    ownFields
  }
  return (value: unknown, isRecordRoot = false): unknown => {
    try {
      const call: RedactRules = { ...rules, visits: { count: 0 } }
      return walk(value, call, 0, new Set<object>(), !isRecordRoot)
    } catch {
      // The record resisted traversal (a throwing getter, a hostile proxy). It
      // cannot be proven safe, so nothing from it is emitted — a redactor must
      // fail closed, and a logging concern must never throw at its caller.
      return {
        _redactionFailed: true,
        _logKey: RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
      } satisfies RedactionFailedEnvelope
    }
  }
}
