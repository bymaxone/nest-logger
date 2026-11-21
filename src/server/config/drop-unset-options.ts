/**
 * Reads the options a consumer passed with the keys they left unset dropped.
 *
 * Layer: server/config — runs first in `validateOptions` and in `applyDefaults`, so both see the same
 * options. A key that holds `undefined` or `null` says "not set": it is dropped, so the default
 * applies and no validator judges it. An `undefined` left in a group would replace the default in
 * the spread that merges the two. Each KNOWN key is read by property access, not by `Object.entries` or a spread, so a
 * getter on the prototype of a class instance counts as the value it returns.
 */
import { refuse } from './options-refusal.util'
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
  const set: Record<string, unknown> = {}
  for (const key of keys) {
    // `Reflect` reads through a getter like a property access and keeps the dynamic key off the
    // object-injection sink list.
    const value = Reflect.get(source, key) as unknown
    if (value !== undefined && value !== null) Reflect.set(set, key, value)
  }
  return set
}

/** The options that hold a list, and the lists of the `http` group: each is copied once, element by element. */
const LIST_OPTIONS = ['redactPaths', 'errorOwnFieldNames', 'destinations'] as const
const HTTP_LISTS = ['excludePaths', 'secretPathSegments'] as const

/** The most entries a list option may hold: a larger one is refused before any element is read. */
export const MAX_LIST_ENTRIES = 10_000

/**
 * Replace each list under `names` in `holder` by a copy that reads its length once and each index
 * once, so a Proxy or a getter on an element answers one time. A value that is not a list is left
 * as it is, for the validator to refuse; a list longer than {@link MAX_LIST_ENTRIES} is refused here,
 * by the name of the option, before anything is allocated for it.
 *
 * @param holder - The object that holds the lists.
 * @param names - The keys of the lists.
 * @param prefix - What the option is called in the refusal, up to the key.
 */
function copyLists(holder: object, names: readonly string[], prefix: string): void {
  for (const name of names) {
    const value = Reflect.get(holder, name) as unknown
    if (!Array.isArray(value)) continue
    const length = Reflect.get(value, 'length') as number
    if (length > MAX_LIST_ENTRIES) {
      refuse(
        `[BymaxLoggerModule] options.${prefix}${name} holds more than ${String(MAX_LIST_ENTRIES)} entries`
      )
    }
    Reflect.set(
      holder,
      name,
      Array.from({ length }, (_, index) => Reflect.get(value, index) as unknown)
    )
  }
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
    const value = Reflect.get(set, group) as unknown
    if (isRecord(value))
      Reflect.set(set, group, readSet(value, Object.keys(Reflect.get(GROUP_KEYS, group) as object)))
  }
  const service = Reflect.get(set, 'service') as unknown
  // The metadata and the serializers are copied as the defaults copy them, own enumerable keys, so
  // each is read here once.
  if (isRecord(service)) Reflect.set(set, 'service', { ...service })
  const serializers = Reflect.get(set, 'serializers') as unknown
  if (isRecord(serializers)) Reflect.set(set, 'serializers', { ...serializers })
  copyLists(set, LIST_OPTIONS, '')
  const http = Reflect.get(set, 'http') as unknown
  if (isRecord(http)) copyLists(http, HTTP_LISTS, 'http.')
  return set as unknown as BymaxLoggerModuleOptions
}
