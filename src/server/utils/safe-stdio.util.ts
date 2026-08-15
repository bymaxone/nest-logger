/**
 * Raw writes to `process.stdout` / `process.stderr` that cannot crash the host.
 *
 * Layer: server/utils — the single mechanism behind every library-owned write to
 * a process stream. That is EVERY path, not only the fallbacks: the default
 * stdout sink, the last-resort NDJSON rescue, the pre-init buffer drain, and the
 * destination failure reports. The one exception is measured rather than
 * overlooked — `PrettyDevDestination` hands `process.stdout` to `pino-pretty`,
 * which attaches two `'error'` listeners of its own and survived the same closed
 * pipe with nothing from this library on the stream.
 *
 * Covering only the fallbacks was the first version of this module, and it was
 * wrong in the way that mattered most — reported in review and then reproduced
 * against the built artifact. `DefaultStdoutDestination` is what a consumer gets
 * when they configure nothing, it wrote through `process.stdout.write` directly,
 * and no fallback runs in a healthy application. So the ordinary install — the
 * one the release note claimed was fixed — still died on `node app | head`:
 * 0 listeners, no synchronous throw, `UNCAUGHT:EPIPE`, exit 42. A guard that
 * only arms itself once something has already gone wrong protects the paths
 * least likely to be taken.
 *
 * **A `try/catch` around `process.stdout.write` does not do this**, and that was
 * measured rather than assumed. Writing to a closed pipe (`node app | head`)
 * reports EPIPE **asynchronously**, through the stream's `'error'` event, after
 * `write()` has already returned:
 *
 * ```
 * stdout error listeners at start: 0
 * sync result: no-throw          ← the try/catch caught nothing
 * UNCAUGHT:EPIPE                 ← arrived later, as an uncaught exception
 * child exit code: 42            ← the process died
 * ```
 *
 * Node attaches no default `'error'` handler to these streams, so the emit
 * becomes an uncaught exception and kills the process. Several JSDoc comments in
 * this library claimed EPIPE protection from exactly that ineffective pattern —
 * a guarantee asserted in prose and absent from the code, on the paths whose
 * whole purpose is to survive a broken sink.
 *
 * The handler is what actually provides it. It is installed once, lazily, on the
 * first library-owned write — which in a default install is the first log line —
 * and it swallows the error: this library's central promise is that logging
 * cannot crash the application, and a logger that dies because a reader closed a
 * pipe breaks that promise at the worst moment.
 *
 * Installing a listener on a process-wide stream is a real side effect, and it is
 * the consumer's `process.stdout` too: after the first log line, an EPIPE raised
 * by THEIR writes stops being an uncaught exception as well. That is a deliberate
 * trade rather than a leak — the alternative is the crash above — and it is
 * documented in the README under the same reasoning. A consumer's own `'error'`
 * listener is untouched; this only ever adds.
 */

/**
 * The handler itself, held as one shared reference.
 *
 * No-op by design. There is nowhere left to report a broken stdout TO — the
 * reporting path is the thing that just failed — and re-throwing would be the
 * crash this exists to prevent.
 */
const swallowStreamError = (): void => undefined

/**
 * Attach the swallow-EPIPE handler to a stream if it is not already attached.
 *
 * Checked by looking for THIS handler among the stream's listeners rather than
 * by remembering which streams were guarded. Remembering is cheaper but wrong in
 * one way that matters: anything that removes listeners from a process stream —
 * a consumer, a test, another library calling `removeAllListeners()` — would
 * leave the memory saying "guarded" while the protection was gone, and it would
 * never come back. Looking makes it self-healing.
 *
 * It also leaves a consumer's own error handler alone: this adds one listener,
 * it never replaces or removes theirs.
 *
 * @param stream - The process stream about to be written to.
 */
function ensureGuarded(stream: NodeJS.WriteStream): void {
  if (stream.listeners('error').includes(swallowStreamError)) {
    return
  }
  stream.on('error', swallowStreamError)
}

/**
 * Write one line to a process stream without letting a broken pipe crash the host.
 *
 * @param stream - `process.stdout` or `process.stderr`.
 * @param payload - The text to write, newline-terminated by the caller.
 */
function writeSafely(stream: NodeJS.WriteStream, payload: string): void {
  try {
    ensureGuarded(stream)
    stream.write(payload)
  } catch {
    // The synchronous half: a destroyed stream can throw from `write()` itself.
    // Both halves have to be covered — the async one by the handler above, this
    // one here — because either alone leaves a way to die.
  }
}

/**
 * Write one entry to `process.stdout` as raw output, fail-safe.
 *
 * @param payload - The serialized, newline-terminated entry.
 */
export function writeStdoutSafely(payload: string): void {
  writeSafely(process.stdout, payload)
}

/**
 * Write one line to `process.stderr`, fail-safe.
 *
 * @param line - The serialized, newline-terminated line.
 */
export function writeStderrSafely(line: string): void {
  writeSafely(process.stderr, line)
}
