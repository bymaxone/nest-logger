/**
 * Public module-options interfaces for `BymaxLoggerModule`.
 *
 * Layer: server/interfaces — the contracts consumed by `forRoot` /
 * `forRootAsync` plus the nested `HttpOptions` / `OtelOptions` shapes and
 * the async factory pair. The synchronous and asynchronous variants are
 * intentionally separate types (not a union) so the dynamic-module helper
 * can branch on shape without runtime discrimination.
 */
import type { ModuleMetadata, Type } from '@nestjs/common'

import type { ILogDestination } from './log-destination.interface'
import type { LogLevel } from '../../shared/types/log-level.type'
import type { ServiceMetadata } from '../../shared/types/service-metadata.type'

/**
 * HTTP module configuration — used by the optional HTTP interceptor and filter.
 *
 * Every field is optional; defaults are applied by `applyDefaults`.
 */
export interface HttpOptions {
  /** Mount the HTTP interceptor + filter. Default: false. */
  isEnabled?: boolean
  /** Capture unhandled HTTP exceptions and emit `HTTP_EXCEPTION_UNHANDLED`. Default: true. */
  shouldCaptureExceptions?: boolean
  /** Generate `requestId` when the request header is absent. Default: true. */
  shouldGenerateRequestId?: boolean
  /**
   * Paths that bypass HTTP logging (health checks, metrics). Defaults:
   * `/health`, `/metrics`.
   *
   * The defaults do NOT cover `@bymax-one/nest-core`, and that is the common case
   * worth knowing before you rely on them. It serves liveness and readiness at
   * `/health/live` and `/health/ready`, and no bare `/health` at all, so
   * `/^\/health$/` excludes a route that does not exist while both probes are
   * logged. Measured on one deployment: 8272 of 8274 HTTP entries were the
   * liveness probe. Set `excludePaths` yourself when wiring the two together —
   * `[/^\/health\/(live|ready)$/, /^\/metrics$/]` matches the stock layout.
   *
   * The defaults are not widened to include those subpaths because both prefixes
   * are CONFIGURABLE there (`DEFAULT_HEALTH_PATH`, `DEFAULT_METRICS_PATH`): any
   * default naming specific subpaths would be less wrong rather than correct, and
   * a prefix pattern would silently swallow a consumer's own `/health/*` route
   * that they did want logged. Excluding a path is a decision about which requests
   * disappear from the record, so it stays explicit.
   *
   * SECURITY: each pattern is `.test()`-ed against the (attacker-controllable)
   * request path on every request. Supply only anchored, linear-time regexes
   * (e.g. `/^\/health$/`); a pattern with catastrophic backtracking would turn a
   * crafted URL into a ReDoS vector. The defaults are anchored and safe.
   */
  excludePaths?: readonly RegExp[]
  /** Header name carrying the tenant identifier. Default: `x-tenant-id`. */
  tenantIdHeader?: string
}

/**
 * OpenTelemetry integration tuning — applied by `TraceContextMixin` when the
 * `@opentelemetry/api` peer dependency is installed.
 */
export interface OtelOptions {
  /** Inject the active span's trace/span IDs into every log entry. Default: true. */
  shouldAutoInjectTraceContext?: boolean
  /**
   * Shortcut that derives sensible defaults for `traceIdField` / `spanIdField` /
   * `traceFlagsField` based on a target casing.
   *
   *   - `'camelCase'` (default) → `traceId` / `spanId` / `traceFlags`
   *   - `'snake_case'`          → `trace_id` / `span_id` / `trace_flags`
   *     (OTel Logs Data Model wire format)
   *
   * Individual `*Field` overrides ALWAYS win over the shortcut.
   */
  fieldFormat?: 'camelCase' | 'snake_case'
  /** Override the field name for the trace ID. */
  traceIdField?: string
  /** Override the field name for the span ID. */
  spanIdField?: string
  /** Override the field name for the trace flags. */
  traceFlagsField?: string
}

/**
 * Synchronous configuration for `BymaxLoggerModule.forRoot()`.
 */
export interface BymaxLoggerModuleOptions {
  /** Mandatory service metadata — emitted on every log entry. */
  service: ServiceMetadata
  /** Minimum level emitted. Default: `info` in production, `debug` otherwise. */
  level?: LogLevel
  /** Register the module as `@Global()`. Default: true. */
  isGlobal?: boolean
  /**
   * @deprecated Not read by the module — a module cannot call `app.useLogger()`
   *   itself (it never sees the `INestApplication`). Call
   *   `BymaxLoggerModule.useNestLogger(app)` in `main.ts` instead. Default: true.
   */
  shouldUseAsNestLogger?: boolean
  /**
   * Additional `fast-redact` paths, applied on top of the default coverage
   * whatever `redactStrategy` is in force.
   */
  redactPaths?: readonly string[]
  /**
   * Engine backing the DEFAULT redaction set (never the consumer's own
   * `redactPaths`, which are always `fast-redact` paths).
   *
   *   - `'names'` (default) — one recursive walk censoring any value whose KEY
   *     NAME is in `REDACT_COMMON_FIELDS`, at ANY depth. ~943 k logs/s.
   *   - `'paths'` — the pre-1.2 engine: `DEFAULT_REDACT_PATHS` handed to
   *     `fast-redact`. Matches only wildcard depths 1–4 and measures ~9.3 k
   *     logs/s. Provided as an escape hatch for a consumer depending on exact
   *     path-matching semantics; expect it to be removed in a future major.
   */
  redactStrategy?: 'names' | 'paths'
  /**
   * Shape of the resource/service identity on every entry. Default `'nested'`.
   *
   *   - `'nested'` — `{ service: { name, version, namespace, instance: { id } },
   *     deployment: { environment: { name } } }`. The historical shape, extended;
   *     no existing query breaks.
   *   - `'flat'` — the dotted OTel attribute names verbatim (`service.name`,
   *     `service.instance.id`, `deployment.environment.name`), which is what a
   *     collector mapping log fields onto resource attributes reads directly.
   *
   * Both carry the same values; only the key shape differs.
   */
  resourceFormat?: 'nested' | 'flat'
  /**
   * Field carrying the machine-readable event name, mirroring `logKey`.
   * Default `'event.name'`; `false` emits nothing.
   *
   * `logKey` stays exactly as it is — this is additive, never a rename.
   *
   * The value is meant to be mapped onto the **`EventName`** field of the
   * OpenTelemetry LogRecord, which is Stable in the Logs Data Model. Note that
   * the same-named `event.name` *attribute* is Deprecated in the semantic
   * conventions precisely because the value belongs in that top-level field
   * instead; the key here is the JSON carrier, not an OTLP attribute. The name is
   * configurable so a pipeline that maps a different key can use it.
   *
   * Keep event names LOW cardinality — `payment.failed`, not
   * `payment.failed.918231781`. Identifiers belong in their own fields.
   */
  eventNameField?: string | false
  /**
   * Shape of the error fields on an entry. Default `'pino'`.
   *
   *   - `'pino'`   — only the legacy `err` object (`type`, `message`, `stack`,
   *     plus the `cause` chain). What every existing query reads.
   *   - `'semconv'` — only the OpenTelemetry attributes: `exception.type`,
   *     `exception.message`, `exception.stacktrace` and `error.type`. The `err`
   *     object is removed, so this is an explicit migration, never a default.
   *   - `'both'`    — both shapes on the same entry. Recommended while moving
   *     dashboards over: nothing breaks, and the new fields are already there.
   *
   * All four attributes are **Stable** in Semantic Conventions v1.44.0.
   * `error.type` carries the error's class name and is LOW cardinality by
   * construction — never a message, never an identifier.
   */
  errorFormat?: 'pino' | 'semconv' | 'both'
  /** Censor string written in place of redacted values. Default: `[REDACTED]`. */
  redactCensor?: string
  /** Disable default redact paths (use with caution). Default: false. */
  shouldDisableDefaultRedact?: boolean
  /**
   * The sinks every entry is written to.
   *
   * A non-empty list **REPLACES** `DefaultStdoutDestination` — it does not add to
   * it. That is deliberate: a file-only or socket-only deployment has to be able
   * to turn stdout off. It also means a sink supplied here may be the only one
   * the application has, so a destination that fails `onInit` is reported on
   * stderr and, if nothing else initialized, entries fall back to raw NDJSON on
   * stdout rather than disappearing.
   *
   * Include `new DefaultStdoutDestination()` explicitly to keep structured stdout
   * alongside a custom sink.
   *
   * Default: `[new DefaultStdoutDestination()]`.
   */
  destinations?: readonly ILogDestination[]
  /** HTTP module configuration. */
  http?: HttpOptions
  /** OpenTelemetry integration tuning. */
  otel?: OtelOptions
  /** Maximum size in bytes per log entry. Default: 65536. */
  maxEntrySizeBytes?: number
  /** Custom Pino serializers, merged with defaults. */
  serializers?: Record<string, (input: unknown) => unknown>
  /** Custom timestamp function. Default: `() => new Date().toISOString()`. */
  timestamp?: () => string
}

/**
 * Fully-resolved options after `applyDefaults` runs.
 *
 * Every optional field is filled, and the nested `http` / `otel` bags are
 * deep-required because {@link applyDefaults} populates each of their fields.
 * This is the precise shape every runtime layer (pino factory, services,
 * middleware) consumes — distinct from the loosely-typed
 * `BymaxLoggerModuleOptions` the consumer supplies.
 */
export type ResolvedBymaxLoggerModuleOptions = Readonly<
  Required<Omit<BymaxLoggerModuleOptions, 'http' | 'otel'>> & {
    http: Required<HttpOptions>
    otel: Required<OtelOptions>
  }
>

/**
 * Factory interface used by `useExisting` / `useClass` async wiring.
 *
 * Implement this interface when the module options depend on providers that are
 * already in the DI graph (e.g., a `ConfigService`). Pass the class to
 * `forRootAsync({ useClass: MyFactory })` or the token to `useExisting`.
 */
export interface BymaxLoggerModuleOptionsFactory {
  /**
   * Produce the synchronous or asynchronous module options.
   *
   * @returns Resolved or promised `BymaxLoggerModuleOptions`.
   * @throws Any error thrown here propagates as a module-initialisation failure.
   */
  createLoggerOptions(): BymaxLoggerModuleOptions | Promise<BymaxLoggerModuleOptions>
}

/**
 * Asynchronous configuration for `BymaxLoggerModule.forRootAsync()`.
 *
 * Standard NestJS dynamic-module async-options shape — pick `imports` from
 * `ModuleMetadata` to allow re-using the consumer's providers in the factory.
 */
export interface BymaxLoggerModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Factory producing the module options. The `unknown[]` parameter shape
   * matches the heterogeneous `inject` array — NestJS resolves each token
   * independently and passes the resolved providers as positional args, so a
   * tighter generic would force every consumer to widen the signature with
   * `as` casts at the call site.
   */
  useFactory?: (...args: unknown[]) => BymaxLoggerModuleOptions | Promise<BymaxLoggerModuleOptions>
  /** Provider tokens NestJS must resolve and forward to `useFactory`. */
  inject?: readonly (string | symbol | Type<unknown>)[]
  /** Reuse an existing factory provider already registered in the DI graph. */
  useExisting?: Type<BymaxLoggerModuleOptionsFactory>
  /** Instantiate a factory class and call its `createLoggerOptions()`. */
  useClass?: Type<BymaxLoggerModuleOptionsFactory>
}
