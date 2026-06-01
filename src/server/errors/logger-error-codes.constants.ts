/**
 * Internal error codes emitted by `@bymax-one/nest-logger` itself when the
 * library's own setup or runtime guards fail.
 *
 * These codes are NOT part of the public log-key catalog
 * (`RESERVED_LOG_KEYS`) because consumers do not subscribe to them as
 * application events — they only surface inside library diagnostics.
 */
export const LOGGER_ERROR_CODES = Object.freeze({
  /** Module options failed structural validation. */
  LOGGER_INVALID_OPTIONS: 'LOGGER_INVALID_OPTIONS',
  /** A passed-in `level` is not a known Pino LogLevel. */
  LOGGER_INVALID_LEVEL: 'LOGGER_INVALID_LEVEL',
  /** Consumer asked for pretty-print but `pino-pretty` is not installed. */
  LOGGER_PRETTY_UNAVAILABLE: 'LOGGER_PRETTY_UNAVAILABLE',
  /** Consumer enabled OTel correlation but `@opentelemetry/api` is missing. */
  LOGGER_OTEL_API_UNAVAILABLE: 'LOGGER_OTEL_API_UNAVAILABLE',
  /** A registered destination threw during its `onInit()` hook. */
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  /** A registered destination threw or rejected during `write()`. */
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  /** Code accessed `LogContext` outside an AsyncLocalStorage scope. */
  LOGGER_CONTEXT_OUT_OF_SCOPE: 'LOGGER_CONTEXT_OUT_OF_SCOPE',
  /** A serialized entry exceeded `maxEntrySizeBytes` and was truncated. */
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED'
} as const)

/**
 * Strongly-typed union of every internal error code value, derived from
 * {@link LOGGER_ERROR_CODES}.
 */
export type LoggerErrorCode = (typeof LOGGER_ERROR_CODES)[keyof typeof LOGGER_ERROR_CODES]
