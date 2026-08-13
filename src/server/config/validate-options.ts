/**
 * Structural validator for `BymaxLoggerModuleOptions`.
 *
 * Layer: server/config — runs at module bootstrap before any Pino instance
 * is created. Throws actionable English errors prefixed with
 * `[BymaxLoggerModule]` so consumers can grep for them in CI logs.
 *
 * Constraint: zero external runtime deps (no zod). The validator hand-rolls
 * the checks against the closed `LogLevel` set sourced from
 * `LOG_LEVEL_PRIORITY` so the two cannot drift.
 */
import { LOG_LEVEL_PRIORITY } from '../constants/log-levels.constants'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

/**
 * Validate the synchronous module options at bootstrap.
 *
 * Throws with actionable English error messages prefixed by
 * `[BymaxLoggerModule]` so consumers can grep for them.
 *
 * @param options — Options passed to `BymaxLoggerModule.forRoot()`.
 * @throws Error when `service` / `service.name` / `service.version` is missing
 *   or empty (after `trim()`).
 * @throws Error when `level` is set to a value outside the Pino LogLevel set.
 * @throws Error when `maxEntrySizeBytes` is set to a non-positive value.
 */
export function validateOptions(options: BymaxLoggerModuleOptions): void {
  if (!options.service) {
    throw new Error('[BymaxLoggerModule] options.service is required')
  }
  if (typeof options.service.name !== 'string' || options.service.name.trim() === '') {
    throw new Error('[BymaxLoggerModule] options.service.name must be a non-empty string')
  }
  if (typeof options.service.version !== 'string' || options.service.version.trim() === '') {
    throw new Error('[BymaxLoggerModule] options.service.version must be a non-empty string')
  }
  if (options.level !== undefined && !LOG_LEVEL_PRIORITY.includes(options.level)) {
    throw new Error(
      `[BymaxLoggerModule] options.level must be one of: ${LOG_LEVEL_PRIORITY.join(
        ', '
      )}. Got: ${String(options.level)}`
    )
  }
  if (options.maxEntrySizeBytes !== undefined && options.maxEntrySizeBytes <= 0) {
    throw new Error('[BymaxLoggerModule] options.maxEntrySizeBytes must be > 0')
  }
  if (
    options.redactStrategy !== undefined &&
    options.redactStrategy !== 'names' &&
    options.redactStrategy !== 'paths'
  ) {
    throw new Error(
      `[BymaxLoggerModule] options.redactStrategy must be 'names' or 'paths'. Got: ${String(
        options.redactStrategy
      )}`
    )
  }
  // The three options below are CLOSED sets, and an unvalidated one fails
  // silently rather than loudly: an unrecognised `resourceFormat` falls through
  // to the nested branch, an unrecognised `errorFormat` behaves as `'both'`
  // because only `'pino'` short-circuits, and an EMPTY `eventNameField` writes a
  // field named `''` onto every structured entry. A typo in a config file would
  // ship to production looking like it worked.
  if (
    options.resourceFormat !== undefined &&
    options.resourceFormat !== 'nested' &&
    options.resourceFormat !== 'flat'
  ) {
    throw new Error(
      `[BymaxLoggerModule] options.resourceFormat must be 'nested' or 'flat'. Got: ${String(
        options.resourceFormat
      )}`
    )
  }
  if (
    options.errorFormat !== undefined &&
    options.errorFormat !== 'pino' &&
    options.errorFormat !== 'semconv' &&
    options.errorFormat !== 'both'
  ) {
    throw new Error(
      `[BymaxLoggerModule] options.errorFormat must be 'pino', 'semconv' or 'both'. Got: ${String(
        options.errorFormat
      )}`
    )
  }
  // `false` is a valid value (emit nothing); a non-empty string names the field.
  // Anything else — including `''` and `true` — is a misconfiguration.
  if (
    options.eventNameField !== undefined &&
    options.eventNameField !== false &&
    (typeof options.eventNameField !== 'string' || options.eventNameField.length === 0)
  ) {
    throw new Error(
      `[BymaxLoggerModule] options.eventNameField must be a non-empty string or false. Got: ${String(
        options.eventNameField
      )}`
    )
  }
}
