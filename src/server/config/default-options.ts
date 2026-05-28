/**
 * Defaults merger for `BymaxLoggerModuleOptions`.
 *
 * Layer: server/config — produces the frozen options snapshot that every
 * other runtime layer reads. Spread-merges consumer overrides with
 * `DEFAULT_HTTP` and `DEFAULT_OTEL`, applies the `otel.fieldFormat`
 * snake_case shortcut, and deep-freezes the result (top-level plus `http`,
 * `otel`, `excludePaths`, `redactPaths`, `destinations`) so per-request
 * handlers cannot corrupt the shared runtime snapshot.
 */
import type {
  BymaxLoggerModuleOptions,
  HttpOptions,
  OtelOptions
} from '../interfaces/logger-module-options.interface'

const DEFAULT_HTTP: Required<HttpOptions> = {
  isEnabled: false,
  captureExceptions: true,
  generateRequestId: true,
  excludePaths: [/^\/health$/, /^\/metrics$/],
  tenantIdHeader: 'x-tenant-id'
}

const DEFAULT_OTEL: Required<OtelOptions> = {
  autoInjectTraceContext: true,
  fieldFormat: 'camelCase',
  traceIdField: 'traceId',
  spanIdField: 'spanId',
  traceFlagsField: 'traceFlags'
}

/**
 * Apply the `fieldFormat` shortcut on top of the merged OTel options.
 *
 * Snake-case shortcut maps `traceId` / `spanId` / `traceFlags` to the OTel
 * Logs Data Model wire format. Individual `*Field` overrides supplied by the
 * consumer always win — the shortcut only fills the gaps.
 */
function applyOtelFieldFormat(
  merged: Required<OtelOptions>,
  user: Partial<OtelOptions> | undefined
): Required<OtelOptions> {
  if (merged.fieldFormat === 'snake_case') {
    return {
      ...merged,
      traceIdField: user?.traceIdField ?? 'trace_id',
      spanIdField: user?.spanIdField ?? 'span_id',
      traceFlagsField: user?.traceFlagsField ?? 'trace_flags'
    }
  }
  return merged
}

/**
 * Merge consumer options with library defaults.
 *
 * Returns a deep-frozen view of the options bag — the top-level object plus
 * `http`, `otel`, `excludePaths`, `redactPaths`, and `destinations` are all
 * frozen so per-request handlers cannot corrupt the shared runtime snapshot.
 *
 * @param options — Raw options as supplied to `BymaxLoggerModule.forRoot()`.
 * @returns Frozen, fully-defaulted options ready for runtime consumption.
 */
export function applyDefaults(
  options: BymaxLoggerModuleOptions
): Readonly<Required<BymaxLoggerModuleOptions>> {
  const isProduction = process.env['NODE_ENV'] === 'production'

  const http: Required<HttpOptions> = { ...DEFAULT_HTTP, ...(options.http ?? {}) }
  const otel: Required<OtelOptions> = applyOtelFieldFormat(
    { ...DEFAULT_OTEL, ...(options.otel ?? {}) },
    options.otel
  )

  const merged: Required<BymaxLoggerModuleOptions> = {
    service: options.service,
    level: options.level ?? (isProduction ? 'info' : 'debug'),
    isGlobal: options.isGlobal ?? true,
    useAsNestLogger: options.useAsNestLogger ?? true,
    redactPaths: Object.freeze([...(options.redactPaths ?? [])]),
    redactCensor: options.redactCensor ?? '[REDACTED]',
    shouldDisableDefaultRedact: options.shouldDisableDefaultRedact ?? false,
    destinations: Object.freeze([...(options.destinations ?? [])]),
    isPretty: options.isPretty ?? !isProduction,
    http: Object.freeze({
      ...http,
      excludePaths: Object.freeze([...http.excludePaths])
    }),
    otel: Object.freeze(otel),
    maxEntrySizeBytes: options.maxEntrySizeBytes ?? 65_536,
    serializers: options.serializers ?? {},
    timestamp: options.timestamp ?? ((): string => new Date().toISOString())
  }
  return Object.freeze(merged)
}
