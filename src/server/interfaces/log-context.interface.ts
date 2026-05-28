/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * Consumer code may extend with arbitrary keys via
 * `LogContextService.set(key, value)`; the index signature permits the
 * extension at the type level.
 */
export interface LogContext {
  /** Correlation ID — typically from `x-request-id` header or generated. */
  requestId?: string
  /** Multi-tenant identifier — read from `x-tenant-id` header or auth claim. */
  tenantId?: string
  /** Authenticated user ID. */
  userId?: string
  /** OpenTelemetry trace ID (32 hex chars). Injected by `TraceContextMixin`. */
  traceId?: string
  /** OpenTelemetry span ID (16 hex chars). */
  spanId?: string
  /** Free-form extensions added by application code. */
  [key: string]: unknown
}
