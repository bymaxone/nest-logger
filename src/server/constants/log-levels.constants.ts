import type { LogLevel } from '../../shared/types/log-level.type'

/**
 * Pino numeric level mapping. Frozen at runtime so destinations and the
 * NestJS bridge can rely on a stable wire-format contract.
 *
 * @see {@link https://github.com/pinojs/pino/blob/main/docs/api.md#level-string}
 */
export const PINO_LEVEL_NUMBERS: Record<LogLevel, number> = Object.freeze({
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10
} as const)

/**
 * Reverse lookup — numeric Pino level → string. Derived from
 * {@link PINO_LEVEL_NUMBERS} so the two cannot drift, then frozen so it is
 * read-only at runtime.
 */
export const PINO_LEVEL_NAMES: Record<number, LogLevel> = Object.freeze(
  Object.fromEntries(
    Object.entries(PINO_LEVEL_NUMBERS).map(([name, num]) => [num, name as LogLevel]) // keys of PINO_LEVEL_NUMBERS are always LogLevel
  ) as Record<number, LogLevel> // Object.fromEntries infers Record<string, V>; numeric index is intentional for level lookups
)

/**
 * NestJS `LogLevel` (`'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal'`)
 * → Pino {@link LogLevel}. Used by `PinoLoggerService` when bridging the
 * variadic NestJS `LoggerService` calls to Pino. Frozen at runtime.
 */
export const NEST_TO_PINO_LEVEL: Record<string, LogLevel> = Object.freeze({
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'trace',
  fatal: 'fatal'
} as const)

/**
 * Severity priority ordering — index reflects severity (low → high).
 * Used by destinations to filter against their configured `minLevel` and by
 * `validateOptions` as the canonical allow-list of `LogLevel` strings.
 * Frozen at runtime to prevent third-party mutation.
 */
export const LOG_LEVEL_PRIORITY: readonly LogLevel[] = Object.freeze([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal'
] as const)
