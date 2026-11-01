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

import { describeCause } from './report-destination-failure.util'
import { writeStderrSafely } from './safe-stdio.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

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

/** Whether the broken-install warning has been written; it is written once per process. */
let brokenInstallWarned = false

/**
 * Forget that the broken-install warning was written.
 *
 * @internal A test seam: it lets a spec observe the once-per-process rule from a clean
 * state. Not re-exported by the package barrel.
 */
export function resetBrokenInstallWarning(): void {
  brokenInstallWarned = false
}

/** One attempt to load the optional peer: what it gave, and the failure that is not an absence. */
interface Attempt {
  readonly api: OtelTraceApi | undefined
  /** Set only when the peer was found but could not be used. */
  readonly broken?: { readonly cause: unknown }
}

/**
 * Whether a failure is `@opentelemetry/api` ITSELF failing to resolve, which is the one
 * outcome that means "not installed".
 *
 * A resolution code alone is not enough: an installed package that lacks one of ITS OWN
 * dependencies fails with the same code and a message naming that dependency, and Node
 * lists the package's path in the require stack. So the first line of the message has to
 * name `@opentelemetry/api` as the module that could not be found.
 *
 * @param cause - The value thrown by the resolver.
 */
function isOtelApiMissing(cause: unknown): boolean {
  try {
    const { code, message } = cause as { code?: unknown; message?: unknown }
    return (
      code === 'MODULE_NOT_FOUND' &&
      /^Cannot find module '@opentelemetry\/api'/.test(String(message))
    )
  } catch {
    return false
  }
}

/**
 * Load `@opentelemetry/api` through a resolver anchored at `anchor()`.
 *
 * The anchor is a THUNK, not a string, so it is evaluated inside a guard. A bundler that
 * emits neither `__filename` nor a shim makes that reference throw `ReferenceError`, and
 * evaluating it at module scope would throw at LOAD time — before any caller could catch
 * it, taking the application down over an optional peer dependency. Deferring it turns
 * that case into the same "nothing to resolve from" outcome as a missing module: it is a
 * property of the environment, and the working-directory fallback covers it.
 *
 * Only the peer being ABSENT is silent. A peer that is found but throws while loading, or
 * resolves to a falsy export, is a broken install: it is reported through `broken` so the
 * caller can say so, rather than being folded into "not installed".
 *
 * @param anchor - Produces the absolute path resolution walks up from.
 * @returns The OTel `trace` namespace when usable, and the failure when the install is broken.
 */
function loadTraceApiFrom(anchor: () => string): Attempt {
  let from: string
  try {
    from = anchor()
  } catch {
    return { api: undefined }
  }
  try {
    const mod = createRequire(from)('@opentelemetry/api')
    // No optional chaining: a falsy module makes `mod.trace` throw into the catch
    // below, and a falsy export is a broken install, not an absent one.
    return { api: mod.trace as OtelTraceApi | undefined }
  } catch (cause) {
    return isOtelApiMissing(cause) ? { api: undefined } : { api: undefined, broken: { cause } }
  }
}

/**
 * Say once, on stderr, that `@opentelemetry/api` is installed but unusable.
 *
 * Written to stderr and not through the logger: this runs while the logger is being
 * built, before any destination exists. Once per process, because the detector runs at
 * the Pino build and again at bootstrap and a broken install does not change in between.
 *
 * @param cause - The failure that made the install unusable.
 */
function warnBrokenInstallOnce(cause: unknown): void {
  if (brokenInstallWarned) {
    return
  }
  brokenInstallWarned = true
  writeStderrSafely(
    JSON.stringify({
      level: 'warn',
      logKey: RESERVED_LOG_KEYS.LOGGER_OTEL_API_BROKEN,
      msg:
        '@opentelemetry/api is installed but could not be loaded, so traceId and spanId are ' +
        'absent from every entry. Reinstall it, or set otel.shouldAutoInjectTraceContext to false.',
      err: describeCause(cause)
    }) + '\n'
  )
}

/**
 * Where resolution starts, in order: this module's own location, then the working directory.
 * Thunks, so each is evaluated inside the guard that treats a failing one as "nothing to
 * resolve from" rather than at module load.
 */
const DEFAULT_ANCHORS: readonly (() => string)[] = [
  (): string => __filename,
  (): string => join(process.cwd(), 'noop.cjs')
]

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
 * @param anchors - Where resolution starts, tried in order; the default is this module's
 *   location and then the working directory. Injectable so a spec can make an anchor fail.
 * @returns The OTel `trace` API when installed and usable, otherwise `undefined`. A broken
 *   install also warns once on stderr, which a missing one deliberately does not.
 */
export function detectOtelTraceApi(
  anchors: readonly (() => string)[] = DEFAULT_ANCHORS
): OtelTraceApi | undefined {
  let broken: Attempt['broken']
  for (const anchor of anchors) {
    const attempt = loadTraceApiFrom(anchor)
    if (attempt.api !== undefined) {
      return attempt.api
    }
    broken ??= attempt.broken
  }
  if (broken !== undefined) {
    warnBrokenInstallOnce(broken.cause)
  }
  return undefined
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
