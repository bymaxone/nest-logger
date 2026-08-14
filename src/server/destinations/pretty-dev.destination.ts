/**
 * Development-only `ILogDestination` that pipes entries through `pino-pretty`
 * for human-readable, colorized terminal output.
 *
 * Layer: server/destinations — an opt-in sink the consumer adds to
 * `destinations` (or that a dev bootstrap wires) when readable local logs are
 * preferred over raw NDJSON. Production keeps the structured
 * `DefaultStdoutDestination`.
 *
 * `pino-pretty` is an OPTIONAL peer dependency. The transform stream is built
 * lazily inside {@link PrettyDevDestination.onInit} so the library loads (and
 * the package installs) even when `pino-pretty` is absent — the cost only
 * surfaces if a consumer actually enables this destination.
 */
import type { Transform } from 'node:stream'

import type { LogLevel } from '../../shared/types/log-level.type'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Pretty-print destination backed by `pino-pretty`.
 *
 * Lifecycle contract (driven by `DestinationRegistry`):
 *   1. `onInit()` resolves `pino-pretty` and builds the transform (rendering to
 *      `process.stdout`).
 *   2. `write()` forwards each serialized line to the transform.
 *   3. `onShutdown()` flushes and closes the transform.
 *
 * @example
 *   BymaxLoggerModule.forRoot({
 *     service: { name: 'api', version: '1.0.0' },
 *     destinations: [new PrettyDevDestination()]
 *   })
 */
export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  readonly minLevel?: LogLevel

  /**
   * The `pino-pretty` transform stream. Undefined until {@link onInit} succeeds.
   */
  private stream?: Transform

  /**
   * Set when {@link onInit} fails (e.g. `pino-pretty` absent). Distinguishes a
   * permanently-failed destination — whose writes are DROPPED, since the registry
   * dropped it from the active set — from the transient pre-init window, where
   * {@link write} falls back to raw stdout so a bootstrap log is not lost.
   */
  private initFailed = false

  /**
   * @param opts.minLevel — Optional minimum level filter applied by the
   *   destination registry's multi-stream wiring. Omit to accept every level.
   */
  constructor(opts: { minLevel?: LogLevel } = {}) {
    if (opts.minLevel !== undefined) {
      this.minLevel = opts.minLevel
    }
  }

  /**
   * Lazily resolve `pino-pretty` and build the colorized transform that renders
   * each entry to `process.stdout`.
   *
   * @throws Error When `pino-pretty` is not installed — with an actionable
   *   message telling the consumer to install it or drop this destination.
   */
  async onInit(): Promise<void> {
    try {
      // The named `build` export is used instead of the default: `pino-pretty`
      // ships as `export =`, so a dynamic `import(...).default` is not typed,
      // whereas `.build` is a declared namespace export with the same factory.
      //
      // This runs pino-pretty as a MAIN-THREAD transform, which is a documented
      // pino-pretty API but NOT the form Pino's own docs recommend — those show
      // `transport: { target: 'pino-pretty' }`, a worker thread. That form is
      // unreachable here by construction: this library owns the Pino instance and
      // fans out through `pino.multistream`, which does not compose with
      // `transport`. The cost is that prettifying happens on the logging thread,
      // which is acceptable for the development-only sink this is and is the
      // reason it should never be registered in production.
      //
      // `destination: process.stdout` makes pino-pretty render the prettified
      // line through Node's stdout stream. Piping the transform's readable side
      // instead (`stream.pipe(process.stdout)`) would leak the RAW NDJSON to
      // stdout alongside the prettified output — pino-pretty writes the formatted
      // text to its `destination` and passes the original chunk through unchanged.
      const { build } = await import('pino-pretty')
      this.stream = build({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service',
        singleLine: false,
        destination: process.stdout
      })
    } catch {
      // Mark as failed so subsequent writes are dropped rather than falling back
      // to raw stdout here. Duplication is the reason: when a stdout sink IS also
      // registered, a fallback would print every entry twice.
      //
      // Dropping is safe because it is no longer the last word. `DestinationHealth`
      // now holds the only case where dropping would have meant silence — this
      // sink being the ONLY one, which `destinations` replacing the default stdout
      // sink makes easy to arrive at by accident — and rescues those entries as
      // raw NDJSON from the fan-out, above this method. Before that existed, this
      // line was the last link in a chain that lost every log the application
      // produced.
      this.initFailed = true
      throw new Error(
        '[PrettyDevDestination] pino-pretty is not installed. Install it as a peer ' +
          'dependency (`pnpm add -D pino-pretty`) or remove PrettyDevDestination from `destinations`.'
      )
    }
  }

  /**
   * Write a serialized NDJSON entry to the pretty transform.
   *
   * Three states:
   *   - initialized → forward to the pino-pretty transform;
   *   - init failed → DROP, so a co-registered stdout sink is not duplicated. The
   *     fan-out already skips a failed destination before reaching this method
   *     (and rescues the entry when nothing else initialized); this branch is the
   *     belt to that, for any caller holding the destination directly;
   *   - pre-init (transient window before {@link onInit}, e.g. a bootstrap log)
   *     → fall back to raw stdout so the entry is not lost.
   *
   * @param payload — Newline-terminated JSON entry, UTF-8 encoded.
   */
  write(payload: string): void {
    if (this.stream !== undefined) {
      this.stream.write(payload)
      return
    }
    if (this.initFailed) {
      return
    }
    process.stdout.write(payload)
  }

  /**
   * Flush and close the pretty transform, resolving once the stream has ended.
   * A no-op when {@link onInit} never ran.
   */
  async onShutdown(): Promise<void> {
    const stream = this.stream
    if (stream === undefined) {
      return
    }
    // Listen for 'error' as well as the end callback: a stream error during
    // teardown would otherwise leave this promise unsettled AND surface as an
    // uncaught exception, bypassing the registry's shutdown error isolation.
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  }
}
