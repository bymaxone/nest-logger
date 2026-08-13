/**
 * Log keys reserved by `@bymax-one/nest-logger` for its own structured events.
 *
 * Consumer apps SHOULD NOT use these names for application-level events
 * to avoid collision in log aggregation queries (Datadog, Loki, Elastic).
 *
 * Every key here is emitted by some code path, EXCEPT the ones listed in
 * {@link RESERVED_LOG_KEYS_NOT_EMITTED}, which are reserved-only and carry the
 * reason they stay that way. `reserved-log-keys.constants.spec.ts` enforces the
 * split, so a key can never again be declared, documented as a signal, and then
 * silently never written.
 */
export const RESERVED_LOG_KEYS = Object.freeze({
  LOGGER_BOOTSTRAP_OK: 'LOGGER_BOOTSTRAP_OK',
  LOGGER_BOOTSTRAP_WARNING: 'LOGGER_BOOTSTRAP_WARNING',
  LOGGER_SHUTDOWN_OK: 'LOGGER_SHUTDOWN_OK',
  HTTP_REQUEST_START: 'HTTP_REQUEST_START',
  HTTP_REQUEST_SUCCESS: 'HTTP_REQUEST_SUCCESS',
  HTTP_REQUEST_REDIRECT: 'HTTP_REQUEST_REDIRECT',
  HTTP_REQUEST_CLIENT_ERROR: 'HTTP_REQUEST_CLIENT_ERROR',
  HTTP_REQUEST_SERVER_ERROR: 'HTTP_REQUEST_SERVER_ERROR',
  HTTP_REQUEST_COMPLETED: 'HTTP_REQUEST_COMPLETED',
  HTTP_REQUEST_ABORTED: 'HTTP_REQUEST_ABORTED',
  HTTP_EXCEPTION_HANDLED: 'HTTP_EXCEPTION_HANDLED',
  HTTP_EXCEPTION_UNHANDLED: 'HTTP_EXCEPTION_UNHANDLED',
  METHOD_EXECUTION: 'METHOD_EXECUTION',
  METHOD_SLOW_EXECUTION: 'METHOD_SLOW_EXECUTION',
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED',
  LOGGER_REDACTION_FAILED: 'LOGGER_REDACTION_FAILED'
} as const)

/**
 * Keys that are reserved but intentionally never emitted, each with the reason.
 *
 * A name in this map is claimed so no application event can take it, but the
 * library commits to not writing it. Anything NOT listed here must be reachable
 * from some code path — the spec asserts both directions.
 */
export const RESERVED_LOG_KEYS_NOT_EMITTED = Object.freeze({
  /**
   * Superseded before it was ever used. The request lifecycle terminates in one
   * of `HTTP_REQUEST_SUCCESS` / `_REDIRECT` / `_CLIENT_ERROR` / `_SERVER_ERROR`,
   * each carrying the same `duration` a generic "completed" entry would. Emitting
   * it as well would double the terminal access-log volume to say nothing new.
   * It stays claimed so an application cannot repurpose a name that reads like a
   * library event.
   */
  HTTP_REQUEST_COMPLETED: 'reserved: superseded by the four status-specific terminal keys'
} as const)

/**
 * Strongly-typed union of every reserved log key value, derived from
 * {@link RESERVED_LOG_KEYS}. Use this type to constrain log-key arguments.
 */
export type ReservedLogKey = (typeof RESERVED_LOG_KEYS)[keyof typeof RESERVED_LOG_KEYS]
