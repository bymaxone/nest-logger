import type { ServiceMetadata } from './service-metadata.type'

/**
 * Shape of a single log entry as serialized to JSON output.
 *
 * Used by destinations and downstream parsers (Datadog, Loki, Elastic).
 * The trailing index signature `[key: string]: unknown` covers arbitrary
 * structured fields injected by application logs.
 */
export interface LogEntry {
  /** Pino numeric level (30 = info, 50 = error, etc.). */
  level: number
  /** ISO 8601 UTC timestamp string OR epoch milliseconds (numeric). */
  time: string | number
  /** Human-readable message. */
  msg: string
  /** Convention key — `MODULE_ACTION_RESULT` format. */
  logKey?: string
  /** Service metadata snapshot — see {@link ServiceMetadata}. */
  service?: ServiceMetadata
  /** Optional NestJS context (typically the emitting class name). */
  context?: string
  /** Optional correlation IDs propagated via AsyncLocalStorage. */
  requestId?: string
  tenantId?: string
  userId?: string
  /** Optional trace context injected when OpenTelemetry SDK is active. */
  traceId?: string
  spanId?: string
  /** Arbitrary additional fields produced by application logs. */
  [key: string]: unknown
}
