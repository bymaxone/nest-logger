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
import { writeStdoutSafely } from '../utils/safe-stdio.util'

/**
 * How the development terminal renders an entry — a VIEW over the record, never
 * a change to it. Every field maps to the `pino-pretty` option of the same name.
 *
 * Declared here rather than reusing `pino-pretty`'s own `PrettyOptions`, and the
 * reason is load-bearing: a type import from the peer emits a hard
 * `import { PrettyOptions } from 'pino-pretty'` at the top of the published
 * `.d.ts`, so every consumer who type-checks WITHOUT the optional peer installed
 * would hit an unresolved module. That would make an optional peer effectively
 * required — a worse regression than the missing options, and the same
 * contradiction this library already refused when asked to hard-fail on a missing
 * peer. Measured on the built artifact, not assumed.
 *
 * `destination` is deliberately absent. The library owns where entries go; a
 * consumer redirecting the stream would route around the multistream fan-out and
 * the last-resort rescue. Omitting it from this type states the intent — applying
 * the library's own value AFTER the spread in {@link PrettyDevDestination.onInit}
 * is what enforces it, including against an untyped JavaScript caller.
 *
 * @example
 *   // One line per entry, with the fields a project repeats on every line hidden.
 *   const view: PrettyViewOptions = {
 *     singleLine: true,
 *     ignore: 'pid,hostname,service,deployment,event.name'
 *   }
 */
export interface PrettyViewOptions {
  /**
   * Collapse the whole entry onto one line. The single biggest change to how a
   * terminal reads — `false` is what expands one entry into a block.
   * Default: `false`.
   */
  singleLine?: boolean
  /**
   * Comma-separated field names to hide from the rendered line. Display-only:
   * what a real sink receives is untouched. Extend rather than replace when the
   * goal is quieter output — the default already hides the noisiest fields.
   * Default: `'pid,hostname,service'`.
   */
  ignore?: string
  /**
   * Render only the message line, hiding the record entirely. In pretty mode
   * there is no JSON copy behind it (`destinations` REPLACES stdout), so a field
   * hidden here is not visible anywhere — including `logKey`. That is the point
   * of the option rather than a caveat; use `messageFormat` to pull a specific
   * field back into the line. Default: `false`.
   */
  hideObject?: boolean
  /**
   * Template for the message line, e.g. `'[{context}] {msg}'`. The way to keep a
   * chosen field visible when `hideObject` is on.
   */
  messageFormat?: string
  /** Timestamp format, or `false` to leave it raw. Default: `'SYS:HH:MM:ss.l'`. */
  translateTime?: string | boolean
  /** ANSI colour in the rendered line. Default: `true`. */
  colorize?: boolean
}

/** The view this destination renders with when the consumer chooses nothing. */
const DEFAULT_VIEW: Required<
  Pick<PrettyViewOptions, 'colorize' | 'translateTime' | 'ignore' | 'singleLine'>
> = {
  colorize: true,
  translateTime: 'SYS:HH:MM:ss.l',
  ignore: 'pid,hostname,service',
  singleLine: false
}

/**
 * How many pre-init entries are held before the buffer gives up.
 *
 * A bound is required because nothing guarantees `onInit` ever runs — a
 * destination can be constructed and never registered. The number is large
 * enough to cover a real boot (a NestJS application instantiating providers
 * emits tens of entries, not thousands) and small enough that the failure mode
 * is bounded memory rather than a leak.
 */
const MAX_BUFFERED_ENTRIES = 1000

/**
 * Byte ceiling for the pre-init buffer, checked alongside the entry count.
 *
 * The count alone does not bound memory, and that gap was real: a payload has no
 * whole-record size limit — `maxEntrySizeBytes` bounds what a SERIALIZER emits
 * for one field, not the entry — so 1000 held entries carrying large metadata
 * could retain far more than the count suggests, where the previous raw
 * passthrough retained nothing at all. A buffer added for legibility must not
 * become a memory risk during boot.
 *
 * 4 MiB is generous for a real boot (tens of entries, a few hundred bytes each)
 * and small enough that the worst case is a brief allocation rather than a
 * problem. Whichever limit trips first ends the buffering.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/**
 * Emit one entry as raw NDJSON on stdout — the fallback whenever a held entry
 * cannot be rendered.
 *
 * Routed through {@link writeStdoutSafely} rather than wrapping
 * `process.stdout.write` in a `try/catch`. A closed pipe reports EPIPE
 * ASYNCHRONOUSLY, after `write()` has returned, so the catch never sees it and
 * the process dies of an uncaught exception — measured, not assumed. Salvaging a
 * log line must not become the crash it exists to prevent.
 *
 * @param payload - The serialized, newline-terminated NDJSON entry.
 */
function writeRawToStdout(payload: string): void {
  writeStdoutSafely(payload)
}

/**
 * Pretty-print destination backed by `pino-pretty`.
 *
 * Lifecycle contract (driven by `DestinationRegistry`):
 *   1. `onInit()` resolves `pino-pretty`, builds the transform (rendering to
 *      `process.stdout`), and flushes anything written before it existed.
 *   2. `write()` forwards each serialized line to the transform.
 *   3. `onShutdown()` flushes and closes the transform.
 *
 * @example
 *   // Default view — unchanged by the options below.
 *   new PrettyDevDestination()
 *
 *   // One line per entry, with this project's repeated fields hidden.
 *   new PrettyDevDestination({
 *     view: { singleLine: true, ignore: 'pid,hostname,service,deployment,event.name' }
 *   })
 *
 *   // Message-only, with the context pulled back into the line.
 *   new PrettyDevDestination({
 *     view: { hideObject: true, messageFormat: '[{context}] {msg}' }
 *   })
 */
export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  readonly minLevel?: LogLevel

  /** Consumer-chosen view, merged over {@link DEFAULT_VIEW} at init. */
  private readonly view: PrettyViewOptions

  /**
   * The `pino-pretty` transform stream. Undefined until {@link onInit} succeeds.
   */
  private stream?: Transform

  /**
   * Set when {@link onInit} fails (e.g. `pino-pretty` absent). Distinguishes a
   * permanently-failed destination — whose writes are DROPPED, since the registry
   * dropped it from the active set — from the transient pre-init window.
   */
  private initFailed = false

  /**
   * Entries written before {@link onInit} built the transform, held so they can be
   * RENDERED rather than printed raw.
   *
   * The transform cannot exist earlier: loading the optional peer is async, and
   * `onInit` is the first moment the lifecycle offers. Before this buffer those
   * entries went to stdout as raw NDJSON — correct, nothing lost, but a real boot
   * put dozens of JSON lines on screen before the first rendered one, and a
   * developer who had just turned pretty on reasonably concluded it had not
   * worked. Reported from exactly that reading.
   */
  private buffer: string[] = []

  /**
   * Set once {@link MAX_BUFFERED_ENTRIES} is reached. From then on entries go
   * straight to raw stdout — and the buffer is drained raw at the same moment, so
   * the output stays in ORDER rather than replaying old entries after newer ones.
   */
  private bufferOverflowed = false

  /**
   * UTF-8 size of everything currently held, tracked incrementally so the bound
   * costs one `Buffer.byteLength` per entry rather than a walk of the buffer.
   */
  private bufferedBytes = 0

  /**
   * @param opts.minLevel — Optional minimum level filter applied by the
   *   destination registry's multi-stream wiring. Omit to accept every level.
   * @param opts.view — Optional rendering overrides; see {@link PrettyViewOptions}.
   *   Omitted fields keep their default, so `new PrettyDevDestination()` renders
   *   exactly as it did before this option existed.
   */
  constructor(opts: { minLevel?: LogLevel; view?: PrettyViewOptions } = {}) {
    if (opts.minLevel !== undefined) {
      this.minLevel = opts.minLevel
    }
    this.view = opts.view ?? {}
  }

  /**
   * Lazily resolve `pino-pretty` and build the colorized transform that renders
   * each entry to `process.stdout`.
   *
   * @throws Error When `pino-pretty` is not installed — with an actionable
   *   message telling the consumer to install it or drop this destination.
   */
  async onInit(): Promise<void> {
    // No stdout EPIPE guard is installed here, and that is a measured decision
    // rather than an oversight. pino-pretty writes to `process.stdout` itself, so
    // nothing in this library can wrap those writes — but `build({ destination:
    // process.stdout })` attaches two `'error'` listeners of its own, and a child
    // process piped to a closed reader survived and exited 0 with no listener
    // from us at all. Adding one would be code whose need is disproven. The
    // paths this destination DOES own — the pre-init drain and the raw
    // fallbacks — go through `writeStdoutSafely`, which guards lazily.
    try {
      // The named `build` export is used instead of the default: `pino-pretty`
      // ships as `export =`, so a dynamic `import(...).default` is not typed,
      // whereas `.build` is a declared namespace export with the same factory.
      //
      // This runs pino-pretty as a MAIN-THREAD transform: a documented
      // pino-pretty API, but NOT the form Pino's docs recommend
      // (`transport: { target: 'pino-pretty' }`, a worker). That form is
      // unreachable here — this library owns the Pino instance and fans out
      // through `multistream`, which does not compose with `transport`. So
      // prettifying costs the logging thread, which is why this sink is
      // development-only.
      //
      // `destination: process.stdout` makes pino-pretty render the prettified
      // line through Node's stdout stream. Piping the transform's readable side
      // instead (`stream.pipe(process.stdout)`) would leak the RAW NDJSON to
      // stdout alongside the prettified output — pino-pretty writes the formatted
      // text to its `destination` and passes the original chunk through unchanged.
      const { build } = await import('pino-pretty')
      this.stream = build({
        ...DEFAULT_VIEW,
        ...this.view,
        // AFTER the consumer's view, deliberately. Omitting `destination` from
        // `PrettyViewOptions` states that the library owns the sink; applying it
        // last is what ENFORCES it, including against an untyped caller reaching
        // in from JavaScript. A redirected stream would route around the fan-out
        // and the last-resort rescue.
        destination: process.stdout
      })
    } catch {
      // Mark as failed so subsequent writes are dropped rather than falling back
      // to raw stdout here: with a stdout sink also registered, a fallback would
      // print every entry twice. Dropping is safe because it is no longer the last
      // word — `DestinationHealth` covers the case where it would have meant
      // silence (this sink being the only one) by rescuing from the fan-out above.
      this.initFailed = true
      // Buffered entries are emitted RAW rather than discarded. They were held
      // to be rendered; the renderer never arrived, and holding them was this
      // destination's decision — losing a boot log because of it would be a
      // regression the buffer introduced.
      this.flushBuffer((payload) => {
        writeRawToStdout(payload)
      })
      throw new Error(
        '[PrettyDevDestination] pino-pretty is not installed. Install it as a peer ' +
          'dependency (`pnpm add -D pino-pretty`) or remove PrettyDevDestination from `destinations`.'
      )
    }

    // Replayed OUTSIDE the catch above, and guarded per entry. Both matter:
    //
    //   - inside it, a throwing transform write would have been reported as
    //     "pino-pretty is not installed" — a diagnosis that is simply false, sent
    //     to an operator who would then go install a package that is already there;
    //   - and because `flushBuffer` detaches the whole buffer before emitting, the
    //     catch-path raw flush would have found nothing left to recover, losing the
    //     entry that threw AND every entry after it. The buffer exists to stop a
    //     boot log being lost; a replay that loses one is worse than no buffer.
    //
    // A single failed write degrades that entry to raw and the replay continues.
    this.flushBuffer((payload) => {
      try {
        this.stream?.write(payload)
      } catch {
        writeRawToStdout(payload)
      }
    })
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
   *   - pre-init (transient window before {@link onInit}, e.g. every entry NestJS
   *     emits while instantiating providers) → BUFFERED, then rendered through
   *     the transform once it exists. Nothing is lost on any path: if init fails
   *     the buffer is drained raw, and if it overflows it is drained raw in order.
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
    if (this.bufferOverflowed) {
      writeRawToStdout(payload)
      return
    }
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (
      this.buffer.length >= MAX_BUFFERED_ENTRIES ||
      this.bufferedBytes + payloadBytes > MAX_BUFFERED_BYTES
    ) {
      // Give up buffering, and drain what is held BEFORE writing this entry.
      // Draining first is what keeps the output in order: holding the old entries
      // to render later would replay them after the newer raw ones, which reads
      // as corruption rather than as a fallback.
      this.bufferOverflowed = true
      this.flushBuffer(writeRawToStdout)
      writeRawToStdout(payload)
      return
    }
    this.buffer.push(payload)
    this.bufferedBytes += payloadBytes
  }

  /**
   * Hand every buffered entry to `emit`, in arrival order, and empty the buffer.
   *
   * Emptying unconditionally is what makes this safe to call from both the
   * success and failure paths: whichever runs first owns the entries, and the
   * other finds nothing to emit twice.
   *
   * @param emit - Receives each buffered payload, oldest first.
   */
  private flushBuffer(emit: (payload: string) => void): void {
    const held = this.buffer
    this.buffer = []
    this.bufferedBytes = 0
    for (const payload of held) {
      emit(payload)
    }
  }

  /**
   * Flush and close the pretty transform, resolving once the stream has ended.
   * A no-op when {@link onInit} never ran.
   */
  async onShutdown(): Promise<void> {
    const stream = this.stream
    if (stream === undefined) {
      // Shut down before `onInit` ever ran. Anything still held was buffered to
      // be rendered by a transform that will now never exist, so it goes out raw
      // rather than dying with the process — the buffer must not become a way to
      // lose entries that the previous raw-passthrough would have printed.
      this.flushBuffer(writeRawToStdout)
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
