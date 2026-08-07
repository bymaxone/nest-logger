/**
 * Optional OpenTelemetry trace-API detection.
 *
 * Layer: server/utils — resolves `@opentelemetry/api` lazily so the library
 * works with or without the optional peer dependency installed. The
 * `TraceContextMixin` calls `detectOtelTraceApi` once at Pino-instance build
 * time and injects `traceId` / `spanId` only when a real OTel SDK is active.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Minimal structural subset of `@opentelemetry/api`'s `trace` namespace that
 * the mixin depends on. Typed locally so the library never needs
 * `@opentelemetry/api` at compile time.
 */
export interface OtelTraceApi {
  /** Returns the active span, or `undefined` when no span is in scope. */
  getActiveSpan():
    | {
        spanContext(): { traceId: string; spanId: string; traceFlags: number }
      }
    | undefined
}

/**
 * Lazily resolve the `@opentelemetry/api` `trace` namespace.
 *
 * Resolution is anchored to `process.cwd()` rather than `import.meta.url`: the
 * latter fails to compile under the CommonJS test transform (TS1343), while
 * `process.cwd()` keeps one source compiling cleanly across ESM, the test
 * transform, and both tsup bundle formats. Node walks up from the working
 * directory to find the optional peer dependency in the consumer's
 * `node_modules`.
 *
 * @returns The OTel `trace` API when installed, otherwise `undefined`.
 */
export function detectOtelTraceApi(): OtelTraceApi | undefined {
  try {
    // Stryker disable next-line StringLiteral: NOT equivalent, and not a coverage gap — the suite kills this mutant, verified by applying the mutation by hand and watching the suite turn red. Stryker fails to attribute the killing test to it under `perTest` coverage analysis, on a full run as well as a scoped one, so it reports as surviving. Ignored on that ground rather than reclassified as equivalent, which would be false.
    const requireFromCwd = createRequire(join(process.cwd(), 'noop.cjs'))
    const mod = requireFromCwd('@opentelemetry/api')
    // No optional chaining: a missing module throws (caught below) and a falsy
    // module makes `mod.trace` throw into the same catch — both yield undefined.
    return mod.trace as OtelTraceApi | undefined
  } catch {
    return undefined
  }
}

/**
 * Check whether a trace ID is a valid, non-zero W3C Trace Context value.
 *
 * Enforces 32 lowercase hex characters (rejecting non-hex input that could
 * carry log-injection payloads) and rejects the all-zeros "no trace" sentinel.
 *
 * @param traceId - The candidate trace ID.
 * @returns `true` when the ID is 32 lowercase hex chars and not all zeros.
 */
export function isValidTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId)
}

/**
 * Check whether a span ID is a valid, non-zero W3C Trace Context value.
 *
 * Enforces 16 lowercase hex characters and rejects the all-zeros sentinel, so a
 * malformed span from a misbehaving SDK never reaches the log stream.
 *
 * @param spanId - The candidate span ID.
 * @returns `true` when the ID is 16 lowercase hex chars and not all zeros.
 */
export function isValidSpanId(spanId: string): boolean {
  return /^[0-9a-f]{16}$/.test(spanId) && !/^0+$/.test(spanId)
}
