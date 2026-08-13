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
 * Any internal failure — including a censor that cannot be written — degrades the
 * whole record to a marked, secret-free envelope rather than crashing the request
 * that produced it.
 *
 * @see {@link createNameRedactor}
 */
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
  const clone = Object.create(
    Object.getPrototypeOf(error) as object,
    Object.getOwnPropertyDescriptors(error)
  ) as Error
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
  return clone
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

/**
 * Internal control-flow signal: a censor could not be written onto a copy.
 *
 * Thrown by {@link defineOwn} and caught by {@link createNameRedactor}, which
 * turns it into the fail-closed envelope. It carries no message because the
 * message is never surfaced — this value never leaves the module — and a
 * pre-allocated instance keeps the failure path allocation-free.
 */
const WRITE_FAILED = new Error()

/**
 * Write a key onto a copy without triggering a setter.
 *
 * `Reflect.defineProperty` rather than assignment: a key named `__proto__`
 * reaching an ordinary assignment would walk the prototype chain to
 * `Object.prototype`'s accessor and repoint the copy's prototype instead of
 * storing a property. Defining the property keeps a hostile key inert AND keeps
 * the dynamic write off the `security/detect-object-injection` sink list.
 *
 * @param target - The copy being built.
 * @param key - The property name.
 * @param value - The value to store.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // Only `enumerable` is specified. `writable` / `configurable` would default to
  // `false`, and nothing here can tell the difference: `Object.keys` yields each
  // key once so a copy never redefines one, and the copy is serialized and
  // discarded without further mutation (verified against Pino's `redact`, which
  // tolerates a non-writable property on the record it censors). Stating them
  // would be two more literals no test could ever pin.
  //
  // The RESULT is checked because `Reflect.defineProperty` reports failure by
  // returning `false` rather than throwing. An `Error` cloned with a
  // non-configurable enumerable property keeps that descriptor, so redefining it
  // silently no-ops and the raw value survives into the log. A censor that
  // cannot be written is a failed redaction, and a failed redaction must fail
  // closed — this throws into the caller's guard, which drops the record.
  if (!Reflect.defineProperty(target, key, { value, enumerable: true })) {
    throw WRITE_FAILED
  }
}

/**
 * Copy-on-write walk of an array's elements. Split out of {@link walk} to keep
 * both bodies within the project's nesting limit.
 *
 * @param value - The array to inspect.
 * @param sensitive - Field names whose values are censored.
 * @param censor - Replacement written in place of a sensitive value.
 * @param depth - Depth of `value` itself; elements are one deeper.
 * @param ancestors - References on the current path (cycle guard).
 * @returns The array itself when no element changed, otherwise a copy.
 */
function walkArray(
  value: readonly unknown[],
  sensitive: ReadonlySet<string>,
  censor: string,
  depth: number,
  ancestors: Set<object>
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
      walk(Reflect.get(value, index), sensitive, censor, depth + 1, ancestors)
    )
  }
  return copy
}

/**
 * Recursive snapshotting walk. Every value is read exactly once and pinned into
 * a fresh structure, so the result is guaranteed to equal what was inspected.
 *
 * @param value - The value to inspect.
 * @param sensitive - Field names whose values are censored.
 * @param censor - Replacement written in place of a sensitive value.
 * @param depth - Current depth, against {@link REDACT_MAX_TRAVERSAL_DEPTH}.
 * @param ancestors - References on the current path (cycle guard).
 * @returns The value, or a redacted copy of it.
 */
function walk(
  value: unknown,
  sensitive: ReadonlySet<string>,
  censor: string,
  depth: number,
  ancestors: Set<object>,
  honorToJson = true
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
  if (ancestors.has(value)) {
    return REDACT_CIRCULAR
  }
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
    const toJson = honorToJson ? resolvedToJson.method : undefined
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
      if (Object.keys(value).some((key) => sensitive.has(key.toLowerCase()))) {
        return censor
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
      return walk(toJson.call(value), sensitive, censor, depth + 1, ancestors)
    }

    // A callable with no `toJSON` reaches here. It must be handed back as-is:
    // walking it would replace it with a plain object, and `JSON.stringify`
    // omits a bare function rather than emitting `{}`.
    if (typeof value === 'function') {
      return value
    }

    if (Array.isArray(value)) {
      return walkArray(value, sensitive, censor, depth, ancestors)
    }

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
    const copy =
      value instanceof Error
        ? (cloneError(value as Error) as unknown as Record<string, unknown>)
        : {}
    for (const key of keys) {
      const current = Reflect.get(source, key)
      defineOwn(
        copy,
        key,
        sensitive.has(key.toLowerCase())
          ? censor
          : walk(current, sensitive, censor, depth + 1, ancestors)
      )
    }
    return copy
  } finally {
    ancestors.delete(value)
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
 * @returns A pure function mapping a value to its redacted equivalent.
 * @example
 *   const redact = createNameRedactor(['password'], '[REDACTED]')
 *   redact({ user: { deep: { password: 's' } } })
 *   // → { user: { deep: { password: '[REDACTED]' } } }
 */
export function createNameRedactor(fieldNames: readonly string[], censor: string): Redactor {
  // Matched case-INSENSITIVELY. HTTP header names are case-insensitive by spec,
  // and only INBOUND Node headers arrive lower-cased — a hand-built or outbound
  // bag routinely carries `Authorization`, `Cookie`, `X-API-Key`, which a
  // case-sensitive set left in clear despite the documented header coverage.
  // Applying it to every name rather than only to headers costs one
  // `toLowerCase()` per key (~4 % of an entry, measured) and errs toward
  // redacting `Password` / `Email` too, which is the safe direction.
  const sensitive: ReadonlySet<string> = new Set(fieldNames.map((name) => name.toLowerCase()))
  return (value: unknown, isRecordRoot = false): unknown => {
    try {
      return walk(value, sensitive, censor, 0, new Set<object>(), !isRecordRoot)
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
