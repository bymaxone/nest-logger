/**
 * The limits of the redaction walk, the markers it writes in place of what it will not expand, and the
 * envelope it writes for a record it could not read.
 *
 * Layer: server/utils — shared with the walk in `redact-by-name.util.ts`, which re-exports them.
 */
import type { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

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

/** The root field that holds the `logKey` of an entry. */
export const LOG_KEY_FIELD = 'logKey'

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
