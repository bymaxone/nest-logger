import type { LogLevel } from './log-level.type'
import type { EmittedDeploymentResource, EmittedServiceResource } from './service-metadata.type'

/**
 * Shape of a single log entry as serialized to JSON output.
 *
 * Used by destinations and downstream parsers (Loki, Elastic, Datadog).
 * The trailing index signature `[key: string]: unknown` covers arbitrary
 * structured fields injected by application logs.
 *
 * `level` and `time` describe what the library ACTUALLY writes. Before `1.2.0`
 * they were declared `number`, which the runtime never produced: the Pino
 * instance is built with `formatters.level` returning the string label and a
 * `timestamp` function emitting an ISO 8601 string. A destination written
 * against the old declaration type-checked and then failed at runtime — the
 * README's own Loki example called `BigInt(entry.time)` on an ISO string, which
 * throws. See `log-entry-contract.e2e-spec.ts`, which asserts the declaration
 * against a real serialized record so the two can never drift again.
 */
export interface LogEntry {
  /**
   * Severity as the Pino string label (`'info'`, `'error'`, …) — NOT the numeric
   * code. Convert with `PINO_LEVEL_NUMBERS` when a numeric column is needed.
   */
  level: LogLevel
  /**
   * ISO 8601 UTC timestamp string, e.g. `'2026-08-12T09:25:46.520Z'`. Parse with
   * `Date.parse(entry.time)` for epoch milliseconds. A consumer-supplied
   * `timestamp` option may change the format, but never the type.
   */
  time: string
  /** Human-readable message. */
  msg: string
  /** Convention key — `MODULE_ACTION_RESULT` format. */
  logKey?: string
  /**
   * Service identity as EMITTED — see {@link EmittedServiceResource}. Not the
   * configuration shape: `service.instance.id` nests, and the environment lives
   * under `deployment`, not here.
   */
  service?: EmittedServiceResource
  /** Deployment identity as emitted — see {@link EmittedDeploymentResource}. */
  deployment?: EmittedDeploymentResource
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
