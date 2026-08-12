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
 * pays — and benchmarks at ~943 k logs/s for byte-identical output.
 *
 * It is also STRICTLY SAFER than the paths it replaces:
 *   - unbounded depth (the wildcard list stopped at four levels; anything
 *     nested deeper leaked);
 *   - a sensitive key is caught wherever it appears, so a headers bag logged as
 *     `{ headers: { authorization } }` is covered, not only the exact
 *     `req.headers.authorization` shape the absolute paths pinned.
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
 * Whether a value's children should be walked.
 *
 * Plain objects and arrays traverse. Excluded, and why each exclusion is safe
 * rather than a hole:
 *   - `Error` — the copy would be a plain object, and Pino's `err` serializer
 *     keys off the instance. Errors are covered on the other side instead: the
 *     factory redacts every SERIALIZER'S OUTPUT, which is where an error's own
 *     enumerable properties actually surface.
 *   - `ArrayBuffer` views (`Buffer`, typed arrays) — indexed byte containers; a
 *     key-name match is meaningless and the copy would be enormous.
 *   - anything carrying `toJSON` (`Date`, `Decimal`, Luxon, Prisma types) — its
 *     serialized form is produced by that method, so the own properties this
 *     walk would see are not what reaches the log.
 *
 * `Map` / `Set` / `RegExp` need no special case: they expose no own enumerable
 * keys, so the walk returns them by reference anyway.
 *
 * @param value - A non-null object.
 * @returns `true` when the walk should descend into `value`.
 */
function isTraversable(value: object): boolean {
  if (value instanceof Error || ArrayBuffer.isView(value)) {
    return false
  }
  // No `Array.isArray` fast path: a plain array carries no `toJSON`, so it
  // already answers `true` here. Adding the early return would be dead logic
  // AND would make an exotic `class extends Array { toJSON() {…} }` traversable,
  // flattening away the very method that decides its serialized form.
  return typeof (value as { toJSON?: unknown }).toJSON !== 'function'
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
  if (!isTraversable(value)) {
    return value
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return walkArray(value, sensitive, censor, depth, ancestors)
    }

    const source = value as Record<string, unknown>
    let copy: Record<string, unknown> | undefined
    for (const key of Object.keys(source)) {
      const current = Reflect.get(source, key)
      const next = sensitive.has(key)
        ? censor
        : walk(current, sensitive, censor, depth + 1, ancestors)
      if (next !== current) {
        // Spreading only on the first change keeps a clean subtree allocation-free.
        // The spread also flattens a class instance to its own enumerable
        // properties — which is exactly what `JSON.stringify` would have emitted
        // for it anyway, so the serialized output is unchanged.
        copy ??= { ...source }
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
 * @param fieldNames - Sensitive field names, matched case-sensitively (the same
 *   semantics `fast-redact` applied, so the default set behaves as it always has;
 *   Node lower-cases inbound HTTP header names before they can reach a log).
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
  const sensitive: ReadonlySet<string> = new Set(fieldNames)
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
