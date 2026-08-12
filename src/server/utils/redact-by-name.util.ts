/**
 * Name-based recursive redaction.
 *
 * Layer: server/utils — the engine behind the library's DEFAULT PII protection.
 * It walks a log record once and censors every value whose KEY NAME is in the
 * sensitive set, at any depth.
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
 *   - unbounded depth (the wildcard list stopped at four levels; anything
 *     nested deeper leaked);
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
 * Contract: COPY-ON-WRITE and NEVER-THROW. Nothing the caller passed is
 * mutated — a subtree with no sensitive key is returned by reference, so a clean
 * record allocates nothing. Any internal failure degrades the whole record to a
 * marked, secret-free envelope rather than crashing the request that produced it.
 *
 * @see {@link createNameRedactor}
 */
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

/**
 * Traversal ceiling. Not a redaction ceiling in any realistic sense — real log
 * payloads are single-digit-deep, and the value it replaced was FOUR — but an
 * unbounded recursion over a pathological (or hostile) self-similar structure
 * would exhaust the call stack, and a logging concern must never crash its
 * caller. Past this depth the value is dropped, NOT passed through: failing
 * closed is the only safe direction for a redactor.
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

/**
 * Read a `toJSON` method off a value, if it has a callable one.
 *
 * @param value - A non-null object.
 * @returns The bound-callable method, or `undefined`.
 */
function readToJson(value: object): (() => unknown) | undefined {
  const candidate = (value as { toJSON?: unknown }).toJSON
  return typeof candidate === 'function' ? (candidate as () => unknown) : undefined
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
  Reflect.defineProperty(target, key, { value, enumerable: true })
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
  let copy: unknown[] | undefined
  let index = 0
  // Iterated (not indexed) and written through `Reflect.set`, keeping both the
  // read and the write off the `security/detect-object-injection` sink list —
  // the idiom the rest of this package already uses.
  for (const current of value) {
    const next = walk(current, sensitive, censor, depth + 1, ancestors)
    if (next !== current) {
      copy ??= [...value]
      Reflect.set(copy, index, next)
    }
    index++
  }
  return copy ?? (value as unknown[])
}

/**
 * Recursive copy-on-write walk. Returns `value` itself when nothing beneath it
 * changed, so an untouched record costs one traversal and zero allocations.
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
  ancestors: Set<object>
): unknown {
  if (value === null || typeof value !== 'object') {
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
  // Stryker disable next-line ConditionalExpression,BlockStatement: output-equivalent, kept for COST — `Buffer` has a `toJSON`, so without this guard the walk below would call it and materialise a `{ type, data: number[] }` copy of every logged binary payload on every entry. A 10 MB buffer becomes a 10-million-element array. No assertion can observe the difference because copy-on-write returns the buffer either way; the guard is a performance bound, not a correctness one.
  if (ArrayBuffer.isView(value)) {
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
    const toJson = readToJson(value)
    if (toJson !== undefined) {
      const serialized = toJson.call(value)
      const walked = walk(serialized, sensitive, censor, depth, ancestors)
      return walked === serialized ? value : walked
    }

    if (Array.isArray(value)) {
      return walkArray(value, sensitive, censor, depth, ancestors)
    }

    const source = value as Record<string, unknown>
    const isError = value instanceof Error
    let copy: Record<string, unknown> | undefined
    for (const key of Object.keys(source)) {
      const current = Reflect.get(source, key)
      const next = sensitive.has(key.toLowerCase())
        ? censor
        : walk(current, sensitive, censor, depth + 1, ancestors)
      if (next !== current) {
        // Copying only on the first change keeps a clean subtree allocation-free.
        // An Error is cloned through its prototype and descriptors so it stays an
        // Error; anything else is spread, which flattens a class instance to its
        // own enumerable properties — exactly what `JSON.stringify` would have
        // emitted for it anyway, so the serialized output is unchanged.
        copy ??= isError
          ? (cloneError(value as Error) as unknown as Record<string, unknown>)
          : { ...source }
        defineOwn(copy, key, next)
      }
    }
    return copy ?? source
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Build a redactor that censors every value whose key name is in `fieldNames`,
 * at any depth, in a single copy-on-write traversal.
 *
 * @param fieldNames - Sensitive field names, matched case-INSENSITIVELY so a
 *   header bag carrying `Authorization` is covered as well as `authorization`.
 * @param censor - Replacement written in place of a sensitive value.
 * @returns A pure function mapping a value to its redacted equivalent.
 * @example
 *   const redact = createNameRedactor(['password'], '[REDACTED]')
 *   redact({ user: { deep: { password: 's' } } })
 *   // → { user: { deep: { password: '[REDACTED]' } } }
 */
export function createNameRedactor(
  fieldNames: readonly string[],
  censor: string
): (value: unknown) => unknown {
  // Matched case-INSENSITIVELY. HTTP header names are case-insensitive by spec,
  // and only INBOUND Node headers arrive lower-cased — a hand-built or outbound
  // bag routinely carries `Authorization`, `Cookie`, `X-API-Key`, which a
  // case-sensitive set left in clear despite the documented header coverage.
  // Applying it to every name rather than only to headers costs one
  // `toLowerCase()` per key (~4 % of an entry, measured) and errs toward
  // redacting `Password` / `Email` too, which is the safe direction.
  const sensitive: ReadonlySet<string> = new Set(fieldNames.map((name) => name.toLowerCase()))
  return (value: unknown): unknown => {
    try {
      return walk(value, sensitive, censor, 0, new Set<object>())
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
