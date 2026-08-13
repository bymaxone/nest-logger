/**
 * Dependency-injection tokens used by `BymaxLoggerModule`.
 *
 * Symbols (rather than strings) are used to guarantee uniqueness across the
 * entire NestJS DI graph — two consumers cannot collide on the same token by
 * accident, and accidental string typos cannot resolve a foreign provider.
 *
 * This mirrors the pattern established by `@bymax-one/nest-auth` for every
 * shared Bymax NestJS library.
 */

/** Injection token for the resolved `BymaxLoggerModuleOptions` snapshot. */
export const LOGGER_OPTIONS_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_OPTIONS')

/** Injection token for the underlying Pino instance (used by services and mixins). */
export const LOGGER_PINO_INSTANCE_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_PINO_INSTANCE')

/** Injection token for the resolved destinations array (read-only at runtime). */
export const LOGGER_DESTINATIONS_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_DESTINATIONS')

/**
 * Injection token for the redaction function backing the DEFAULT PII coverage.
 *
 * Exposed as its own provider because `PinoLoggerService.child()` has to apply
 * it BEFORE handing bindings to Pino: child bindings are pre-serialized into the
 * instance's `chindings` fragment and never reach `formatters.log`, so the
 * factory's hook cannot see them.
 */
export const LOGGER_REDACTOR_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_REDACTOR')

/** Injection token for the per-request AsyncLocalStorage-backed log context. */
export const LOG_CONTEXT_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_LOG_CONTEXT')
