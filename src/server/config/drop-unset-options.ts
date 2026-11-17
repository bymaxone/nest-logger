/**
 * Reads the options a consumer passed with the keys they left unset dropped.
 *
 * Layer: server/config — runs first in `validateOptions` and in `applyDefaults`, so both see the same
 * options. A key that holds `undefined` or `null` says "not set": left in, an `undefined` in a group
 * replaced the default in the spread that merges the two, and a `null` was refused as a value of the
 * wrong kind. Each KNOWN key is read by property access, not by `Object.entries` or a spread, so a
 * getter on the prototype of a class instance counts as the value it returns.
 */
import type {
  BymaxLoggerModuleOptions,
  DestinationQueueOptions,
  HttpOptions,
  OtelOptions,
  ShutdownOptions
} from '../interfaces/logger-module-options.interface'

/** One entry for every key of `T`: a key added to `T` and not listed here does not compile. */
type KnownKeys<T> = { readonly [K in keyof T]-?: true }

const OPTION_KEYS: KnownKeys<BymaxLoggerModuleOptions> = {
  service: true,
  level: true,
  isGlobal: true,
  shouldUseAsNestLogger: true,
  redactPaths: true,
  redactStrategy: true,
  resourceFormat: true,
  eventNameField: true,
  errorFormat: true,
  redactCensor: true,
  shouldDisableDefaultRedact: true,
  destinations: true,
  http: true,
  otel: true,
  maxEntrySizeBytes: true,
  maxStringLength: true,
  destinationHookTimeoutMs: true,
  shutdown: true,
  destinationQueue: true,
  errorOwnFields: true,
  errorOwnFieldNames: true,
  serializers: true,
  timestamp: true
}

/** The keys of each group, by the name of the option that holds it. */
const GROUP_KEYS: {
  readonly http: KnownKeys<HttpOptions>
  readonly otel: KnownKeys<OtelOptions>
  readonly shutdown: KnownKeys<ShutdownOptions>
  readonly destinationQueue: KnownKeys<DestinationQueueOptions>
} = {
  http: {
    isEnabled: true,
    shouldCaptureExceptions: true,
    shouldGenerateRequestId: true,
    excludePaths: true,
    secretPathSegments: true,
    tenantIdHeader: true,
    tenantIdResolver: true
  },
  otel: {
    shouldAutoInjectTraceContext: true,
    fieldFormat: true,
    traceIdField: true,
    spanIdField: true,
    traceFlagsField: true
  },
  shutdown: { timeoutMs: true, drainTimeoutMs: true },
  destinationQueue: { maxBytes: true }
}

const GROUP_NAMES = Object.keys(GROUP_KEYS) as ReadonlyArray<keyof typeof GROUP_KEYS>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The keys of `source` that are set, each read by property access. */
function readSet(source: object, keys: readonly string[]): Record<string, unknown> {
  const read = source as Record<string, unknown>
  const set: Record<string, unknown> = {}
  for (const key of keys) {
    const value = read[key]
    if (value !== undefined && value !== null) set[key] = value
  }
  return set
}

/**
 * The options without the keys that are not set, in the options and in each group.
 *
 * @param options - Options as the consumer passed them; anything that is not an object is returned
 *   as it is, for the validator to refuse.
 * @returns A new object holding only the keys that are set, so a group that is a class instance
 *   comes back as a plain object of the values its getters return.
 */
export function dropUnsetOptions(options: BymaxLoggerModuleOptions): BymaxLoggerModuleOptions {
  if (!isRecord(options)) return options
  const set = readSet(options, Object.keys(OPTION_KEYS))
  for (const group of GROUP_NAMES) {
    const value = set[group]
    if (isRecord(value)) set[group] = readSet(value, Object.keys(GROUP_KEYS[group]))
  }
  return set as unknown as BymaxLoggerModuleOptions
}
