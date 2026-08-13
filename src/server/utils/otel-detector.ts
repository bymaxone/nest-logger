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
 * Load `@opentelemetry/api` through a resolver anchored at `anchor()`.
 *
 * The anchor is a THUNK, not a string, so it is evaluated inside this try. A
 * bundler that emits neither `__filename` nor a shim makes that reference throw
 * `ReferenceError`, and evaluating it at module scope would throw at LOAD time —
 * before any caller could catch it, taking the application down over an optional
 * peer dependency. Deferring it turns that case into the same "unresolvable"
 * outcome as a missing module.
 *
 * @param anchor - Produces the absolute path resolution walks up from.
 * @returns The OTel `trace` namespace, or `undefined` when unresolvable.
 */
function loadTraceApiFrom(anchor: () => string): OtelTraceApi | undefined {
  try {
    const requireFrom = createRequire(anchor())
    const mod = requireFrom('@opentelemetry/api')
    // No optional chaining: a missing module throws (caught below) and a falsy
    // module makes `mod.trace` throw into the same catch — both yield undefined.
    return mod.trace as OtelTraceApi | undefined
  } catch {
    return undefined
  }
}

/**
 * Lazily resolve the `@opentelemetry/api` `trace` namespace.
 *
 * Resolution is anchored to THIS MODULE first, and only falls back to
 * `process.cwd()`.
 *
 * The order matters, and the previous cwd-only order was a real defect. A
 * library installed at `<app>/node_modules/@bymax-one/nest-logger/dist/...`
 * resolves its optional peer by walking up from its own location — which is how
 * Node resolution is defined and how every other dependency in the process is
 * found. Anchoring at the working directory instead asks a different question:
 * "is the peer reachable from wherever the operator happened to launch the
 * process". Those answers diverge under a Docker `WORKDIR` that is not the app
 * root, a pnpm/Yarn workspace whose `node_modules` is hoisted to the repo root,
 * a monorepo started from the repository root, and a serverless bundle. The
 * failure was silent: trace correlation simply switched off, with no error and
 * no warning, so `traceId` was missing exactly where distributed tracing was
 * most likely to be configured.
 *
 * The `process.cwd()` fallback is kept deliberately: in a bundled application
 * this module's path is the bundle's, which may sit outside any `node_modules`
 * tree, and there the working directory is the better guess. Trying both costs
 * one extra resolution attempt, once, at Pino-instance construction.
 *
 * `__filename` is native in CommonJS — both the `.cjs` bundle and the test
 * transform — and tsup's `shims` option injects an `import.meta.url`-derived
 * equivalent into the `.mjs` bundle.
 *
 * @returns The OTel `trace` API when installed, otherwise `undefined`.
 */
export function detectOtelTraceApi(): OtelTraceApi | undefined {
  return (
    loadTraceApiFrom(() => __filename) ?? loadTraceApiFrom(() => join(process.cwd(), 'noop.cjs'))
  )
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
