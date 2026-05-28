/**
 * Log keys reserved by `@bymax-one/nest-logger` for its own structured events.
 *
 * Consumer apps SHOULD NOT use these names for application-level events
 * to avoid collision in log aggregation queries (Datadog, Loki, Elastic).
 *
 * @see technical_specification.md §12.3 for the authoritative list and rationale.
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
  HTTP_EXCEPTION_HANDLED: 'HTTP_EXCEPTION_HANDLED',
  HTTP_EXCEPTION_UNHANDLED: 'HTTP_EXCEPTION_UNHANDLED',
  METHOD_EXECUTION: 'METHOD_EXECUTION',
  METHOD_SLOW_EXECUTION: 'METHOD_SLOW_EXECUTION',
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED'
} as const)

/**
 * Strongly-typed union of every reserved log key value, derived from
 * {@link RESERVED_LOG_KEYS}. Use this type to constrain log-key arguments.
 */
export type ReservedLogKey = (typeof RESERVED_LOG_KEYS)[keyof typeof RESERVED_LOG_KEYS]
