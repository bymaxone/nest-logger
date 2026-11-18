/**
 * The SemConv `exception.*` attributes and `error.type`, derived from the `err` of a log record.
 *
 * Layer: server/utils — pure, no I/O. The fields are the library's own, written after the `err`
 * serializer, so the ceiling that bounds a serializer's output does not reach them; each is cut to
 * `maxEntrySizeBytes` here, on top of the fixed text cap.
 */
import { cutBytes, cutText } from './bounded-text.util'
import { censorStackHeader } from './censor-stack-header.util'
import { scrubStack } from './sanitize-error.util'

/**
 * Writes the SemConv `exception.*` and `error.type` fields from the `err` of `record`, each cut to
 * `maxBytes` UTF-8 bytes on top of the fixed text cap: the fields are the library's own, written
 * after the `err` serializer, so the ceiling that bounds a serializer's output does not reach them.
 *
 * @param record - The record, changed in place.
 * @param maxBytes - The ceiling of each field, in UTF-8 bytes.
 * @param onCut - Called once for each field the ceiling cut, so the cuts can be counted.
 * @param censorMessage - The text of a message after the redaction that covers the name `message`:
 *   the fields are copies of the message of the error, and the stack opens with it.
 */
function deriveExceptionFields(
  record: Record<string, unknown>,
  maxBytes: number,
  onCut: (() => void) | undefined,
  censorMessage: (text: string) => string
): void {
  const bounded = (text: string): string => {
    const cut = cutBytes(text, maxBytes)
    if (cut !== text) onCut?.()
    return cut
  }
  // Optional chaining rather than a type guard: a `null` or primitive `err` yields `undefined` for
  // every field and adds nothing, which is exactly what a guard would have produced. A guard whose
  // presence no input can distinguish is not a check, it is untested code.
  const candidate = record['err'] as
    { name?: unknown; message?: unknown; stack?: unknown } | undefined
  if (typeof candidate?.name === 'string') {
    record['exception.type'] = bounded(cutText(candidate.name))
    record['error.type'] = bounded(cutText(candidate.name))
  }
  const message =
    typeof candidate?.message === 'string'
      ? { text: candidate.message, censored: censorMessage(candidate.message) }
      : undefined
  if (message !== undefined) {
    record['exception.message'] = bounded(cutText(message.censored))
  }
  if (typeof candidate?.stack === 'string') {
    // Same scrubbing the legacy `err.stack` gets. Without it, a consumer moving to
    // `errorFormat: 'semconv'` would silently start seeing dependency frames that the shape they
    // migrated FROM had filtered out.
    const stack =
      message === undefined
        ? candidate.stack
        : censorStackHeader(candidate.stack, message.text, message.censored)
    record['exception.stacktrace'] = bounded(scrubStack(stack))
  }
}

/**
 * Add the Stable OpenTelemetry exception attributes alongside (or instead of)
 * the legacy `err` object.
 *
 * **Stability, verified 2026-08-13 against SemConv v1.44.0.** `exception.type`,
 * `exception.message` and `exception.stacktrace` are **Stable** on log records;
 * the spec requires at least one of `type` / `message` to be present, which is
 * satisfied here because both are derived from the same value. `error.type` is
 * **Stable** and must be low cardinality — it carries the error's CLASS NAME,
 * which is bounded by the number of exception types a codebase defines, never a
 * message or an identifier.
 *
 * `error.type` and `exception.type` are not redundant even when they hold the
 * same string: `exception.type` describes the thrown object, while `error.type`
 * is the classification a consumer aggregates on. Emitting both is what lets a
 * dashboard group by failure class without parsing the exception.
 *
 * Runs at `formatters.log`, so the value read here is the REDACTED copy the walk
 * produced — a cloned `Error` with resolved properties, never the caller's live
 * object. A hostile getter has already been dealt with by the fail-closed guard
 * upstream; the try/catch is the belt to that braces, because this hook must not
 * be the thing that throws inside a log call.
 *
 * @internal Exported only for unit testing. These hooks write fields whose
 *   absence is invisible in a serialized line — `JSON.stringify` drops a key
 *   holding `undefined` — so asserting them through the sink cannot tell an
 *   omitted field from one written as `undefined`. Mutation testing found that
 *   gap. NOT re-exported by the package barrel.
 * @param record - The redacted record about to be serialized.
 * @param format - `'pino'` keeps only `err`; `'semconv'` replaces it; `'both'`
 *   emits each.
 * @param maxBytes - The ceiling of each derived field, in UTF-8 bytes.
 * @param onCut - Called once for each field the ceiling cut.
 * @param censorMessage - Censors the text of a message as the name `message` is; none by default.
 * @returns The record, with the exception attributes applied.
 * @example
 *   withSemconvException({ err: new TypeError('bad') }, 'both')
 *   // → { err: TypeError, 'exception.type': 'TypeError',
 *   //     'error.type': 'TypeError', 'exception.message': 'bad', … }
 */
export function withSemconvException(
  record: Record<string, unknown>,
  format: 'pino' | 'semconv' | 'both',
  maxBytes = Number.POSITIVE_INFINITY,
  onCut?: () => void,
  censorMessage: (text: string) => string = (text) => text
): Record<string, unknown> {
  if (format === 'pino') {
    return record
  }
  try {
    // Optional chaining rather than a type guard: a `null` or primitive `err`
    // yields `undefined` for every field and adds nothing, which is exactly what
    // a guard would have produced. A guard whose presence no input can
    // distinguish is not a check, it is untested code.
    deriveExceptionFields(record, maxBytes, onCut, censorMessage)
    if (format === 'semconv') {
      // Explicitly opted out of the legacy shape. Kept as a deliberate choice
      // rather than a default: `err.*` is what every existing query reads, and
      // dropping it silently would break dashboards that never asked to migrate.
      //
      // Rebuilt rather than deleted: the redaction walk defines every property
      // of its snapshot as non-configurable, so `delete` throws `TypeError` here
      // — silently, into the catch below, leaving `err` in place. Adding keys
      // still works because the object itself is extensible; only the existing
      // properties are pinned. Measured, not assumed.
      const withoutErr: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'err') {
          Reflect.set(withoutErr, key, value)
        }
      }
      return withoutErr
    }
  } catch {
    // A value that resists reading leaves the legacy `err` untouched rather than
    // half-populated attributes. Partial semconv fields would be worse than
    // none: a consumer cannot tell an absent attribute from a failed read.
  }
  return record
}
