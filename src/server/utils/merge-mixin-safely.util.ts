/**
 * The merge of the mixin result with the caller's object, as Pino's `mixinMergeStrategy`.
 *
 * Layer: server/utils — pure, no I/O. Kept apart from the factory so the rule about whose value
 * wins sits in one place and in one file.
 */
import { foldKey } from './fold-key.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

/** The key that names a prototype, which a payload's own copy of it must not reach. */
const PROTOTYPE_KEY = '__proto__'

/** The one key a call site sets explicitly that the request context also writes. */
const EXPLICIT_USER_KEY = 'userId'

/**
 * Pino's `mixinMergeStrategy`: merge the caller's object with the mixin result without letting a
 * throwing getter crash the log call, and without letting the caller's object replace a key the
 * mixin writes.
 *
 * @param mergeObject - The caller's object.
 * @param mixinObject - The mixin result.
 * @returns The merged record, or the mixin result alone marked as a redaction failure.
 */
export function mergeMixinSafely(mergeObject: object, mixinObject: object): object {
  // `formatters.log` is NOT the first code to touch the caller's object: Pino
  // merges the mixin result with it first, and the default strategy's
  // `Object.assign` invokes every own getter. A throwing getter therefore
  // crashed the log call before the redactor could return its fail-closed
  // envelope. Owning the merge moves that boundary inside the guarantee.
  try {
    // Merged into a FRESH target rather than into `mixinObject`. `Object.assign`
    // copies key by key, so a getter that throws part-way leaves everything
    // read before it already written into the target — and the catch below
    // would then emit that prefix, contradicting the sentence it is written
    // under. A disposable target keeps the partial writes in the value that
    // is about to be discarded.
    const merged: Record<string, unknown> = {}
    // The keys the mixin writes, folded: a payload key that only spells one of them (`trace_id` for
    // `traceId`, `request.id` for `requestId`) is read as the same field by a backend that
    // normalises names, so it is dropped like the key itself.
    const written = new Set<string>()
    for (const [key, value] of Object.entries(mixinObject)) {
      if (value !== undefined) written.add(foldKey(key))
    }
    // Copied key by key and never through `Object.assign`: an own `__proto__` key of the payload
    // (a parsed object has one) would swap the prototype of `merged`, and the writes below would
    // then run a setter the payload carries or be dropped by a non-writable property it carries.
    for (const key of Object.keys(mergeObject)) {
      if (key === PROTOTYPE_KEY) continue
      if (key !== EXPLICIT_USER_KEY && written.has(foldKey(key))) continue
      Reflect.set(merged, key, Reflect.get(mergeObject, key))
    }
    // The mixin's keys are the correlation of the entry (the request, the tenant, the trace), so a
    // payload that carries the same key does not replace them. A key the mixin leaves undefined is
    // not written, so it does not erase the payload's own value. `userId` is the exception: a
    // structured call names the acting user as an argument, which must win over the ambient one.
    for (const [key, value] of Object.entries(mixinObject)) {
      if (value === undefined) continue
      if (key === EXPLICIT_USER_KEY && Reflect.get(merged, key) !== undefined) continue
      Reflect.set(merged, key, value)
    }
    return merged
  } catch {
    // The caller's object cannot be read, so it cannot be proven safe and is
    // dropped WHOLE — not up to the property that threw. The mixin's own
    // ambient context (requestId, trace ids) is library-produced and kept.
    return {
      ...mixinObject,
      _redactionFailed: true,
      _logKey: RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
    }
  }
}
