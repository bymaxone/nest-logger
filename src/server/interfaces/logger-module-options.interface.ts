/**
 * Public module-options interfaces for `BymaxLoggerModule`.
 *
 * Layer: server/interfaces — the contracts consumed by `forRoot` /
 * `forRootAsync` plus the nested `HttpOptions` / `OtelOptions` shapes and
 * the async factory pair. The synchronous and asynchronous variants are
 * intentionally separate types (not a union) so the dynamic-module helper
 * can branch on shape without runtime discrimination.
 *
 * See `docs/technical_specification.md` §4.1 for the full semantics of
 * every field.
 */
import type { ModuleMetadata, Type } from '@nestjs/common'

import type { ILogDestination } from './log-destination.interface'
import type { LogLevel } from '../../shared/types/log-level.type'
import type { ServiceMetadata } from '../../shared/types/service-metadata.type'

/**
 * HTTP module configuration — used by the optional HTTP interceptor + filter
 * shipped in Phase 3.
 *
 * Every field is optional; defaults are applied by `applyDefaults`.
 */
export interface HttpOptions {
  /** Mount the HTTP interceptor + filter. Default: false. */
  isEnabled?: boolean
  /** Capture unhandled HTTP exceptions and emit `HTTP_EXCEPTION_UNHANDLED`. Default: true. */
  captureExceptions?: boolean
  /** Generate `requestId` when the request header is absent. Default: true. */
  generateRequestId?: boolean
  /** Paths that bypass HTTP logging (health checks, metrics). Defaults: `/health`, `/metrics`. */
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
  autoInjectTraceContext?: boolean
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
 *
 * See `docs/technical_specification.md` §4.1 for full semantics of every field.
 */
export interface BymaxLoggerModuleOptions {
  /** Mandatory service metadata — emitted on every log entry. */
  service: ServiceMetadata
  /** Minimum level emitted. Default: `info` in production, `debug` otherwise. */
  level?: LogLevel
  /** Register the module as `@Global()`. Default: true. */
  isGlobal?: boolean
  /** Replace the NestJS internal logger via `app.useLogger()`. Default: true. */
  useAsNestLogger?: boolean
  /** Additional Pino redact paths — merged with `DEFAULT_REDACT_PATHS`. */
  redactPaths?: readonly string[]
  /** Censor string written in place of redacted values. Default: `[REDACTED]`. */
  redactCensor?: string
  /** Disable default redact paths (use with caution). Default: false. */
  shouldDisableDefaultRedact?: boolean
  /** Custom destinations beyond `DefaultStdoutDestination`. */
  destinations?: readonly ILogDestination[]
  /** Force pretty-print output. Default: `NODE_ENV !== 'production'`. */
  isPretty?: boolean
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
 * Factory interface used by `useExisting` / `useClass` async wiring.
 */
export interface BymaxLoggerModuleOptionsFactory {
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
