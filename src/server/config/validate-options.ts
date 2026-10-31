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
 *
 * Every option is checked here because each is read later, per entry or per
 * request, as a function, an array, a string or a boolean. A value of the wrong
 * kind fails there, far from its cause, or does not fail at all: the string
 * `'false'` is truthy, an unknown `fieldFormat` behaves as `camelCase`, `null`
 * spreads to nothing.
 */
import { types } from 'node:util'

import { LOG_LEVEL_PRIORITY } from '../constants/log-levels.constants'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

/** Throw the `[BymaxLoggerModule]` error for one option, naming it by its path. */
function reject(path: string, rule: string, got?: unknown): never {
  const received = got === undefined ? '' : `. Got: ${describeValue(got)}`
  throw new Error(`[BymaxLoggerModule] options.${path} ${rule}${received}`)
}

/** What a rejected value was, in a form that never throws and never prints a secret. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** `value`, when defined, must be a boolean. */
function checkBoolean(path: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    reject(path, 'must be a boolean', value)
  }
}

/** `value`, when defined, must be a non-empty string. */
function checkNonEmptyString(path: string, value: unknown): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    reject(path, 'must be a non-empty string', value)
  }
}

/** A group option (`http`, `otel`) is spread over its defaults, so it must be an object. */
function checkGroup(path: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) reject(path, 'must be an object', value)
  return value
}

/** `service`, `level` and `maxEntrySizeBytes`. */
function validateCore(options: BymaxLoggerModuleOptions): void {
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
  const size: unknown = options.maxEntrySizeBytes
  if (size !== undefined && !Number.isFinite(size)) {
    reject('maxEntrySizeBytes', 'must be a finite number', size)
  }
  if (options.maxEntrySizeBytes !== undefined && options.maxEntrySizeBytes <= 0) {
    throw new Error('[BymaxLoggerModule] options.maxEntrySizeBytes must be > 0')
  }
}

/**
 * The closed sets, and an unvalidated one fails silently rather than loudly: an
 * unrecognised `resourceFormat` falls through to the nested branch, an unrecognised
 * `errorFormat` behaves as `'both'` because only `'pino'` short-circuits, and an EMPTY
 * `eventNameField` writes a field named `''` onto every structured entry. A typo in a
 * config file would ship to production looking like it worked.
 */
function validateClosedSets(options: BymaxLoggerModuleOptions): void {
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

/** Redaction and customization options: the switches, the paths, the censor and the hooks. */
function validateCustomization(options: BymaxLoggerModuleOptions): void {
  checkBoolean('isGlobal', options.isGlobal)
  checkBoolean('shouldDisableDefaultRedact', options.shouldDisableDefaultRedact)
  if (options.redactCensor !== undefined && typeof options.redactCensor !== 'string') {
    reject('redactCensor', 'must be a string', options.redactCensor)
  }
  if (options.timestamp !== undefined && typeof options.timestamp !== 'function') {
    reject('timestamp', 'must be a function', options.timestamp)
  }
  const paths: unknown = options.redactPaths
  if (paths !== undefined) {
    if (!Array.isArray(paths)) reject('redactPaths', 'must be an array of strings', paths)
    paths.forEach((entry: unknown, index) => {
      if (!isNonEmptyString(entry)) {
        reject(`redactPaths[${String(index)}]`, 'must be a non-empty string', entry)
      }
    })
  }
  const serializers: unknown = options.serializers
  if (serializers !== undefined) {
    if (!isRecord(serializers)) reject('serializers', 'must be an object', serializers)
    for (const [key, serializer] of Object.entries(serializers)) {
      if (typeof serializer !== 'function') {
        reject(`serializers.${key}`, 'must be a function', serializer)
      }
    }
  }
}

/** Marks a destination member that could not be read, which the registry tolerates. */
const UNREADABLE = Symbol('unreadable')

/**
 * A member of a destination, which may be a getter that throws. The registry and the
 * fan-out read `name`, `write` and the hooks under a guard and contain a failure at its
 * own stage, so the validator reads them the same way instead of aborting bootstrap.
 */
function readMember(destination: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(destination, key) as unknown
  } catch {
    return UNREADABLE
  }
}

/** One entry of `destinations`: it must satisfy the contract the fan-out relies on. */
function validateDestination(entry: unknown, index: number): void {
  const path = `destinations[${String(index)}]`
  if (!isRecord(entry)) {
    reject(path, 'must be an object implementing ILogDestination', entry)
  }
  const write = readMember(entry, 'write')
  if (write !== UNREADABLE && typeof write !== 'function') {
    reject(path, 'must have a write(payload) method')
  }
  const name = readMember(entry, 'name')
  if (name !== UNREADABLE && !isNonEmptyString(name)) {
    reject(path, 'must have a non-empty string name', name)
  }
  for (const hook of ['onInit', 'onShutdown', 'onRegistryReady']) {
    const value = readMember(entry, hook)
    if (value !== UNREADABLE && value !== undefined && typeof value !== 'function') {
      reject(`${path}.${hook}`, 'must be a function', value)
    }
  }
}

/** `destinations`: an array of objects implementing `ILogDestination`. */
function validateDestinations(options: BymaxLoggerModuleOptions): void {
  const destinations: unknown = options.destinations
  if (destinations === undefined) return
  if (!Array.isArray(destinations)) {
    reject('destinations', 'must be an array of ILogDestination', destinations)
  }
  destinations.forEach((entry: unknown, index) => validateDestination(entry, index))
}

/** The `http` group. */
function validateHttp(options: BymaxLoggerModuleOptions): void {
  const http = checkGroup('http', options.http)
  if (http === undefined) return
  checkBoolean('http.isEnabled', http['isEnabled'])
  checkBoolean('http.shouldCaptureExceptions', http['shouldCaptureExceptions'])
  checkBoolean('http.shouldGenerateRequestId', http['shouldGenerateRequestId'])
  const excludePaths = http['excludePaths']
  if (excludePaths !== undefined) {
    if (!Array.isArray(excludePaths)) {
      reject('http.excludePaths', 'must be an array of RegExp', excludePaths)
    }
    // `types.isRegExp`, not `instanceof`: a pattern built in another realm (a `vm`
    // context, a worker, a test sandbox) is a valid RegExp for which `instanceof` is false.
    excludePaths.forEach((pattern: unknown, index) => {
      if (!types.isRegExp(pattern)) {
        reject(`http.excludePaths[${String(index)}]`, 'must be a RegExp', pattern)
      }
    })
  }
  checkNonEmptyString('http.tenantIdHeader', http['tenantIdHeader'])
}

/** The `otel` group. */
function validateOtel(options: BymaxLoggerModuleOptions): void {
  const otel = checkGroup('otel', options.otel)
  if (otel === undefined) return
  checkBoolean('otel.shouldAutoInjectTraceContext', otel['shouldAutoInjectTraceContext'])
  const format = otel['fieldFormat']
  if (format !== undefined && format !== 'camelCase' && format !== 'snake_case') {
    reject('otel.fieldFormat', "must be 'camelCase' or 'snake_case'", format)
  }
  checkNonEmptyString('otel.traceIdField', otel['traceIdField'])
  checkNonEmptyString('otel.spanIdField', otel['spanIdField'])
  checkNonEmptyString('otel.traceFlagsField', otel['traceFlagsField'])
}

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
 * @throws Error when `maxEntrySizeBytes` is not a finite number greater than zero.
 * @throws Error when a closed-set option (`redactStrategy`, `resourceFormat`,
 *   `errorFormat`, `eventNameField`, `otel.fieldFormat`) holds an unknown value.
 * @throws Error when a switch is not a boolean, a hook or serializer is not a
 *   function, a path or header name is not a non-empty string, `excludePaths` is
 *   not an array of `RegExp`, a group (`http`, `otel`) is not an object, or a
 *   `destinations` entry does not satisfy `ILogDestination`.
 */
export function validateOptions(options: BymaxLoggerModuleOptions): void {
  validateCore(options)
  validateClosedSets(options)
  validateCustomization(options)
  validateDestinations(options)
  validateHttp(options)
  validateOtel(options)
}
