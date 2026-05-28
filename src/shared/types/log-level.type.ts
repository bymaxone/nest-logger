/**
 * Pino log levels (mirrored to NestJS-compatible names).
 *
 * Numeric mapping (Pino):
 *   - `fatal` 60
 *   - `error` 50
 *   - `warn`  40
 *   - `info`  30
 *   - `debug` 20
 *   - `trace` 10
 *
 * @example
 *   const level: LogLevel = 'info'
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
