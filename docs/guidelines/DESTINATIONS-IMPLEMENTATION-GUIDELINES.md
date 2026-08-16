# Destinations Implementation Guidelines — `@bymax-one/nest-logger`

> **Version:** 1.0.0
> **Last updated:** 2026-05-27
> **Target:** Pino 10 multi-stream, `sonic-boom`, `thread-stream`
> **Related document:** `docs/technical_specification.md` §5

---

## Table of Contents

1. [`ILogDestination` contract](#1-ilogdestination-contract)
2. [Pino multi-stream — how the lib wires it under the hood](#2-pino-multi-stream)
3. [Backpressure and fail-soft](#3-backpressure-and-fail-soft)
4. [Lifecycle (`onInit`, `onShutdown`)](#4-lifecycle)
5. [Patterns for common destinations](#5-patterns)
6. [Anti-patterns — what a destination MUST NOT do](#6-anti-patterns)
7. [Testing destinations](#7-testing-destinations)
8. [Performance budget](#8-performance-budget)
9. [Test checklist](#9-test-checklist)
10. [Worker-thread caveats — `thread-stream` & `transport`](#10-worker-thread-caveats--thread-stream--transport)

---

## 1. `ILogDestination` contract

```typescript
export interface ILogDestination {
  /** Unique name for debugging/audit. */
  readonly name: string

  /** Minimum log level accepted by this destination. */
  readonly minLevel?: LogLevel

  /**
   * Called for every log entry. Receives the JSON-stringified payload
   * with trailing newline. MUST be non-blocking.
   */
  write(payload: string): void | PromiseLike<void>

  /** Called once at NestJS bootstrap. */
  onInit?(): void | PromiseLike<void>

  /** Called after EVERY destination's `onInit` settled. Only useful if you buffer. */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | PromiseLike<void>

  /** Called at NestJS shutdown. MUST flush + close resources. */
  onShutdown?(): void | PromiseLike<void>
}
```

**Principles:**

- `write` receives a **serialized JSON string** — the destination does not need to parse it (but may).
- `write` is the **hot path** — any extra allocation impacts throughput.
- `onInit` / `onShutdown` are optional; the presence of both ensures proper lifecycle.
- `onRegistryReady` is optional and only matters if you hold entries written **before** your own
  `onInit` ran — see §4.1.

---

## 2. Pino multi-stream

**INTERNAL WIRING (lib-side, consumer never writes this) — `DestinationRegistry` reads `LOGGER_DESTINATIONS_TOKEN` providers and wraps each via the internal `destinationToStream()` helper into a `pino.multistream` array. Consumers only ever supply `ILogDestination` instances via `BymaxLoggerModuleOptions.destinations`.**

The lib registers all destinations via `pino.multistream` internally:

```typescript
import pino from 'pino'

// Inside DestinationRegistry — reads providers bound to LOGGER_DESTINATIONS_TOKEN
const streams = destinations.map((dest) => ({
  level: dest.minLevel ?? 'trace',
  stream: destinationToStream(dest) // internal helper — adapts ILogDestination → Writable stream
}))

const logger = pino({ level: 'trace' }, pino.multistream(streams))
```

> ⚠️ **Critical**: `pino.multistream` requires `pino.level` to be the **lowest** level across all streams. If you have `streams: [{ level: 'info', ... }, { level: 'error', ... }]`, `pino.level` must be `'info'` (not `'error'`) — otherwise the info-level stream **never receives anything**.

### `destinationToStream` helper

> **Internal helper — not exported from the package barrel.** Consumers never import this. It bridges `ILogDestination.write(string)` (our contract) to `Writable` (Pino's contract).

The lib exposes internally:

```typescript
import { Writable } from 'node:stream'

import type { DestinationHealth } from '../services/destination-health.service'
import { writeStderrSafely } from '../utils/safe-stdio.util'

export function destinationToStream(dest: ILogDestination, health: DestinationHealth): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      // A failure is CONTAINED, never propagated. `callback(err)` makes the
      // `Writable` emit `'error'`, which with no listener terminates the host —
      // the opposite of the fail-soft contract in §3. RECORD the failure, report
      // it, then signal success so the fan-out reaches the other sinks.
      //
      // `markWriteFailed` is the half that keeps this from becoming a loss path:
      // without it readiness would still count this sink as having taken the
      // entry, and another destination could discard the copy it was holding.
      // Reporting alone is not containment.
      //
      // Through `writeStderrSafely`, NOT `process.stderr.write`: a closed pipe
      // reports EPIPE asynchronously, so a raw write here would trade a contained
      // destination failure for an uncaught exception. See the EPIPE note in §3.
      const report = (err: unknown): void => {
        health.markWriteFailed(dest)
        writeStderrSafely(
          `${JSON.stringify({ level: 'error', logKey: 'LOGGER_DESTINATION_WRITE_FAILED', destination: dest.name, err: String(err) })}\n`
        )
        callback()
      }
      try {
        const result = dest.write(chunk.toString('utf8'))
        // Branch on `undefined`, NOT on `result instanceof Promise`. `instanceof` is
        // realm-local: it answers `false` for a promise built in a worker or a `vm`
        // context, and for any structurally valid thenable. Either would take the
        // synchronous path, where a later rejection escapes unreported and the entry
        // is lost. `Promise.resolve` assimilates both shapes.
        if (result === undefined) {
          callback()
        } else {
          // Counted while IN FLIGHT. Readiness can be computed before this promise
          // settles, and a pending write must read as unproven rather than as
          // silent success — otherwise a buffering sink discards its copy moments
          // before this one rejects.
          health.markWritePending(dest)
          Promise.resolve(result).then(
            () => {
              health.markWriteSettled(dest)
              callback()
            },
            (err) => {
              health.markWriteSettled(dest)
              report(err)
            }
          )
        }
      } catch (err) {
        report(err)
      }
    }
  })
}
```

Advantages:

- Destinations do not need to extend `Writable` manually
- A failing destination is contained: reported on stderr, never surfaced as a stream error
- Async `write` is supported transparently

---

## 3. Backpressure and fail-soft

### Backpressure

`sonic-boom` (Pino's stream engine) emits `'drain'` events when its internal buffer fills up. Destinations that send to the network (Loki, Datadog) MUST buffer internally and flush in batches.

**Drain contract for our adapter:** `_write` returns `void` — it never signals backpressure by its return value. What it controls is **when** it calls `callback`, and that is the whole mechanism: a chunk stays in flight until the callback fires, so further entries accumulate in the stream's internal buffer. Once that buffer reaches `highWaterMark`, the PUBLIC `writable.write()` returns `false` and the writer pauses; `'drain'` is emitted after the queue clears.

Our `destinationToStream()` adapter defers `callback` only when `dest.write()` returns something other than `undefined` and it has not settled — so sync destinations (stdout, file) never let the buffer grow and never trigger backpressure on the Pino side. This is an intentional contract: synchronous destinations are expected to never block; async destinations opt into backpressure by returning something awaitable.

```typescript
// Inside destinationToStream — an awaitable write defers callback,
// which signals backpressure upstream until it settles. A rejection is
// reported and then completed WITHOUT an error: `callback(err)` would make
// the stream emit `'error'` and take the host down with it.
write(chunk, _enc, callback) {
  const result = dest.write(chunk.toString('utf8'))
  if (result === undefined) callback()
  else Promise.resolve(result).then(() => callback(), report)
}
```

### Reporting from your own destination — `reportToStderrSafely`

The examples below share this helper. The library's own guarded writer is internal
and not importable from a consumer package, so a destination that needs to report
something writes its own — once, not per call site.

```typescript
// One shared reference, so the check below can ask whether OUR listener is still
// attached. A `let guarded = true` flag would go stale the moment anything else
// removed it — a test doing listener cleanup is enough — and every later EPIPE
// would be uncaught again. This is the shape the library's own helper arrived at
// after exactly that defect.
const swallowStderrError = (): void => undefined

export function reportToStderrSafely(line: string): void {
  // The listener covers the ASYNCHRONOUS half (EPIPE, see the note above), the
  // try/catch the synchronous one. Either alone still leaves a way to die.
  //
  // Checked against the actual listener list, and it only ever ADDS: a consumer's
  // own `'error'` handler is left alone, and its presence is not taken as proof
  // that the stream is guarded, because their handler may well rethrow.
  if (!process.stderr.listeners('error').includes(swallowStderrError)) {
    process.stderr.on('error', swallowStderrError)
  }
  try {
    process.stderr.write(line)
  } catch {
    // A destroyed stream throws synchronously; a report is never worth a crash.
  }
}
```

Destinations that send to the network (Loki, Datadog) MUST buffer internally and flush in batches:

```typescript
export class LokiDestination implements ILogDestination {
  readonly name = 'loki'
  private buffer: string[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(
    private readonly opts: { url: string; batchSize?: number; flushIntervalMs?: number }
  ) {}

  /** The background flush currently running, so shutdown can wait for it. */
  private inFlight: Promise<void> = Promise.resolve()

  onInit(): void {
    this.flushTimer = setInterval(() => this.flushInBackground(), this.opts.flushIntervalMs ?? 5000)
  }

  write(payload: string): void {
    this.buffer.push(payload)
    if (this.buffer.length >= (this.opts.batchSize ?? 100)) {
      this.flushInBackground()
    }
  }

  // Detached, so it must not reject: an unhandled rejection terminates the host.
  // Chained rather than fired in parallel, and RETAINED in `inFlight`, so
  // `onShutdown` can await a flush that is already running — otherwise a batch it
  // requeues on failure is stranded after the process has stopped draining.
  private flushInBackground(): void {
    this.inFlight = this.inFlight.then(() => this.flush()).catch(() => undefined)
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    try {
      const response = await fetch(this.opts.url, {
        method: 'POST',
        body: this.formatLokiPush(batch)
      })
      // `fetch` REJECTS only on a network-level failure. A 401, 429 or 500 resolves
      // normally, so without this check the batch is spliced out and dropped on
      // exactly the failures a log sink sees most.
      if (!response.ok) {
        throw new Error(`Loki responded ${response.status} ${response.statusText}`)
      }
    } catch (err) {
      // Fail soft is NOT the same as discarding the batch. Put it back so the next
      // flush retries it, and report — an empty catch here loses every entry in it
      // while the adapter has already recorded them as taken.
      this.buffer.unshift(...batch)
      reportToStderrSafely(
        JSON.stringify({
          level: 'error',
          logKey: 'LOGGER_DESTINATION_WRITE_FAILED',
          destination: 'loki',
          retained: batch.length,
          error: err instanceof Error ? err.message : String(err)
        }) + '\n'
      )
      throw err
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    // Wait for a background flush already running before draining what is left:
    // it may requeue its batch on failure, and those entries would otherwise be
    // stranded in a buffer nobody drains again.
    await this.inFlight
    // NOT swallowed here: the registry catches, reports and isolates a failing
    // `onShutdown`, and a batch lost at shutdown is one nobody else is holding.
    await this.flush()
  }

  private formatLokiPush(batch: string[]): string {
    return JSON.stringify({
      streams: [
        { stream: {}, values: batch.map((line) => [String(Date.now() * 1e6), line.trim()]) }
      ]
    })
  }
}
```

### Fail-soft is REQUIRED

A failure in one destination MUST NOT affect the others — and the adapter, not your destination, is what guarantees that. **Principle: let the failure reach the adapter.** Throw, or return a rejecting promise; `destinationToStream` catches both, reports the failure on stderr and completes the write without an error.

**Do not catch and swallow.** A swallowed failure looks like a successful write from the outside, so `DestinationHealth.markWriteFailed` never runs for your sink — and readiness may then credit it with having taken entries it actually dropped, letting ANOTHER destination discard the held copies it was keeping. Hiding your own failure is how an entry stops existing anywhere. If you must log something yourself, never do it via the logger (infinite loop), and see the EPIPE note below before writing to `process.stderr` directly.

> **A `try/catch` around `process.stderr.write` is not EPIPE protection**, and this was measured rather than assumed. When the reader closes the pipe (`node app | head`), the stream reports `EPIPE` **asynchronously** through its `'error'` event, after `write()` has already returned — so the `catch` sees nothing, and because Node attaches no default handler to these streams the emit becomes an uncaught exception that kills the process (measured: 0 listeners, no synchronous throw, exit code 42). If your destination writes to `process.stdout`/`process.stderr` directly, attach a swallowing `'error'` listener to the stream once, in addition to the `try/catch` — the catch covers the synchronous half (a destroyed stream can still throw from `write()`), the listener covers the asynchronous one, and either alone leaves a way to die. The library's own fallback paths route every raw write through one internal helper that does exactly this.

---

## 4. Lifecycle

| Hook              | When                                       | What to do                                             |
| ----------------- | ------------------------------------------ | ------------------------------------------------------ |
| `onInit`          | NestJS bootstrap, before the first log     | Open connections, start flush timer, validate config   |
| `write`           | Every log                                  | Push to internal buffer; flush in batch if ≥ batchSize |
| `onRegistryReady` | After every destination's `onInit` settled | Resolve anything you buffered before your own init     |
| `onShutdown`      | NestJS `SIGTERM` / `app.close()`           | Stop timers, flush remaining buffer, close connections |

### 4.1 `onRegistryReady` — only if you buffer before init

Skip this hook unless your destination holds entries written before its own `onInit` ran. If you do
hold them, you face a question you cannot answer alone: **were those entries also delivered by
someone else?** The fan-out hands each entry to every registered destination whose level accepts it,
so a held copy may be a second copy — emitting it duplicates a line, and dropping it may lose one.

The library answers it for you, once, after every `onInit` has settled:

This example takes the library's own trade — **dedupe when the signal says another sink took the
entries, emit otherwise** — and it is a trade, not a proof. Read the limits below before copying it
into a destination that cannot tolerate any loss.

```ts
onRegistryReady(status: { readonly heldEntriesDeliveredElsewhere: boolean }): void {
  // Best-effort deduplication: drop the held copies when another sink appears to
  // have taken them, emit otherwise. See the residual risk below.
  if (status.heldEntriesDeliveredElsewhere) {
    this.buffer.length = 0
    return
  }
  for (const payload of this.buffer.splice(0)) writeRawSomewhere(payload)
}
```

`heldEntriesDeliveredElsewhere` is `true` only when another sink is not you, initialized, sits at or
below your effective level, has had no write failure, and has no write still in flight. Anything less
certain is reported as `false`.

**It is a deduplication signal, not a proof, and the difference matters because you may be dropping
your only copy.** The accounting covers writes the library has handed to a destination; one still
queued inside the `Writable` adapter, behind a slow async sink not yet called, is invisible — so
`true` can precede a queued write that later fails, and nothing distinguishes that case for you. It
normally arrives, being queued rather than lost.

So pick deliberately: the library's own destinations dedupe on `true` because a duplicated boot line
is a smaller harm than a lost one. **If your destination cannot tolerate ANY loss, ignore the flag
and always emit** — you will duplicate lines in the common configuration, and you will never drop
one.

Two more things this hook guarantees, because they were each a defect first:

- **It is called on FAILED destinations too** — the one that could not initialize is exactly the one
  still holding entries.
- **It is awaited.** Return a promise if you need to; a rejection is reported and contained, and the
  bootstrap entry is not emitted until every hook has settled.

### What happens when `onInit` fails

Throwing from `onInit` is a legitimate way to say "I cannot run" — it never aborts application bootstrap. The library then guarantees three things, and you should design against them rather than around them:

1. **The failure is reported as `LOGGER_DESTINATION_INIT_FAILED` on `process.stderr`** — never through the logger. Your sink may be the only one registered, so routing the explanation through the logger would deliver it into the sink that just died.
2. **Your destination is excluded from the write fan-out.** `write()` is not called after a failed `onInit`, so you never have to defend it with an "am I initialized?" flag. (Keep one anyway if `write()` can be reached from your own code.)
3. **If _no_ destination initialized, entries fall back to raw NDJSON on `stdout`.** Degraded and unformatted, but nothing is lost — including the bootstrap entries.

That third guarantee exists because `destinations` **replaces** the default stdout sink (see §1). Before it, a single sink that failed `onInit` left the application booting, running, exiting `0` and writing nothing anywhere — with the diagnostic explaining why delivered into the dead sink.

The fallback inherits your destination's effective level (`minLevel`, else the module `level`): the rescue delivers what a working sink would have delivered, never more. The `stderr` report is outside the fan-out, so no `minLevel` can hide it.

**Implication for your `onInit`:** validate config and fail loudly there rather than degrading silently inside `write()`. A destination that throws from `onInit` produces a named diagnostic; one that swallows the problem and drops entries in `write()` produces silence.

### Flush guarantee at shutdown

The lib calls `destination.onShutdown()` in **reverse registration order** — the last registered closes first. This ensures downstream destinations (e.g., Loki) process the final batch before upstream (stdout) is closed.

```typescript
// In BymaxLoggerModule (internal)
async onApplicationShutdown(): Promise<void> {
  for (const dest of [...this.destinations].reverse()) {
    try {
      await dest.onShutdown?.()
    } catch (err) {
      writeStderrSafely(`Destination "${dest.name}" shutdown failed: ${err}\n`)
      // Continue — one failure does not block the others
    }
  }
}
```

> ⚠️ The app **must** call `app.enableShutdownHooks()` in `main.ts` for `OnApplicationShutdown` to fire.

---

## 5. Patterns for common destinations

### 5.1 Stdout JSON (default)

The lib registers it automatically if no destination is provided. Trivial implementation:

```typescript
export class DefaultStdoutDestination implements ILogDestination {
  readonly name = 'stdout-json'
  write(payload: string): void {
    process.stdout.write(payload)
  }
}
```

### 5.2 Pretty (dev only)

> **This section previously showed a simplified sketch that does not match the shipped destination, and two of its lines taught patterns the real implementation exists to avoid.** It is replaced below by the shape that is actually correct. If you copied the old example into a destination of your own, the two notes at the end are the ones to check.

```typescript
export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  private stream?: Transform

  // The transform is built in onInit, NOT in a field initializer or the
  // constructor: the peer is optional, so resolving it is `await import(...)`,
  // and a constructor cannot await. Entries that arrive before this runs are
  // buffered and flushed through the transform here.
  async onInit(): Promise<void> {
    const { build } = await import('pino-pretty')
    this.stream = build({
      ...defaults,
      ...consumerView,
      // AFTER the consumer's options: the library owns the sink.
      destination: process.stdout
    })
    this.flushBuffer((payload) => this.stream?.write(payload))
  }

  write(payload: string): void {
    if (this.stream !== undefined) {
      this.stream.write(payload)
      return
    }
    // Held to be rendered, not printed raw — see §4 for where held entries end
    // up when the transform never arrives.
    this.buffer.push(payload)
  }

  async onShutdown(): Promise<void> {
    /* flush + end the transform; drain the buffer raw if it never initialized */
  }
}
```

Two things the old sketch got wrong, both worth stating because they are easy to reproduce:

- **`stream.pipe(process.stdout)` leaks the raw NDJSON.** `pino-pretty` writes the _formatted_ text to its `destination` and passes the original chunk through unchanged, so piping the readable side prints both the prettified line and the raw JSON. Pass `destination` instead.
- **Building the transform eagerly makes the optional peer mandatory.** A field initializer or constructor call runs at `new`, so a consumer who has not installed `pino-pretty` crashes on construction rather than getting the actionable `onInit` failure and the degraded-but-visible fallback described in §4.

> `pino-pretty` is an **optional peer dep**. If it is absent, `PrettyDevDestination.onInit()` **throws** with an actionable message, and the generic init-failure path takes over (§4): the failure is reported as `LOGGER_DESTINATION_INIT_FAILED` on stderr, the destination is dropped from the fan-out, and — if it was the only one registered — entries fall back to raw NDJSON on stdout.
>
> Earlier revisions of this guide described a `LOGGER_PRETTY_UNAVAILABLE` key emitted for this case. **No such entry is ever written.** The name survives only in `logger-error-codes.constants.ts`, which is not exported and not used; do not build a dashboard on it. The searchable signal is `LOGGER_DESTINATION_INIT_FAILED` on stderr, with `destination: "pretty-dev"`.

### An optional peer is still resolvable after `pnpm prune --prod`

Do not reason "the peer is a `devDependency`, so a production install strips it, so this destination cannot run in production." **It is false under pnpm**, disproved in real production images by two consumers who had assumed it independently — and by two _different_ build routes:

```
pnpm prune --prod                       → store entry kept, peer still linked
pnpm install --prod --frozen-lockfile   → peer installed in a CLEAN stage
  (fresh runtime stage, no prune anywhere)

require.resolve('pino-pretty')                        → MODULE_NOT_FOUND   (from the app root)
require.resolve('pino-pretty', { paths: [<libdir>] })  → resolves under .pnpm/
container booted with the pretty sink registered       → ANSI output, healthy
```

The mechanism is **not** "prune left something behind" — the second image never prunes. In both, the peer was recorded in the lockfile and pnpm placed it in the store for a production-only install; the lazy `import()` inside the library then resolves relative to the library's real path under `.pnpm/`, where the peer is a sibling.

**Stated as what was measured, not as a law of pnpm:** two production images, two different build routes, both with the peer in the lockfile. Whether a prod install always carries an optional peer regardless of how the lockfile was produced has not been tested here, and the advice does not depend on it — what matters is that "we do a clean prod install rather than a prune" is not the exemption it reads like. That reasoning is exactly what made the second consumer expect a different answer before measuring their own image.

A caution when checking this yourself: `require.resolve` from the library's **app-visible** path returns `MODULE_NOT_FOUND` while the import still succeeds, because the library resolves from its real `.pnpm/` path instead. A consumer nearly published the opposite conclusion from exactly that probe. Verify by behaviour — does the sink render? — not by resolving from a path the library never uses.

**Other package managers differ, in the opposite direction.** Under npm's or yarn's flat `node_modules` a pruned devDependency really is absent. Do not carry this warning across ecosystems.

The consequence for a destination author is general, not specific to pretty: **packaging is not a guard.** If your destination must not run in a given environment, gate it on an explicit configuration value that is visible and validated — never on the assumption that its dependency will be missing. The failure mode when you get this wrong is the quiet kind: nothing crashes, nothing warns, and a log pipeline silently fails to parse every line.

### 5.3 Rolling file (`pino-roll`)

```typescript
import pinoRoll from 'pino-roll'
import type { Writable } from 'node:stream'

export class RollingFileDestination implements ILogDestination {
  readonly name = 'rolling-file'
  private stream!: Writable

  constructor(
    private readonly opts: { file: string; frequency: 'daily' | 'hourly'; size?: string }
  ) {}

  async onInit(): Promise<void> {
    this.stream = await pinoRoll({ ...this.opts, mkdir: true })
  }

  write(payload: string): void {
    this.stream.write(payload)
  }

  async onShutdown(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve))
  }
}
```

### 5.4 HTTP endpoint (Loki/Datadog)

See §3 — pattern with buffer + flush timer + batch.

### 5.5 Database (Postgres/Prisma)

```typescript
import type { PrismaClient } from '@prisma/client'

export class PrismaPostgresDestination implements ILogDestination {
  readonly name = 'postgres'
  private buffer: Record<string, unknown>[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: { batchSize?: number; flushIntervalMs?: number } = {}
  ) {}

  /** The background flush currently running, so shutdown can wait for it. */
  private inFlight: Promise<void> = Promise.resolve()

  onInit(): void {
    this.flushTimer = setInterval(() => this.flushInBackground(), this.opts.flushIntervalMs ?? 2000)
  }

  write(payload: string): void {
    // No try/catch. A malformed payload throws, the adapter catches it, records
    // the sink as write-failed and reports it under LOGGER_DESTINATION_WRITE_FAILED
    // — all of which a `catch` here would suppress, leaving readiness to credit
    // this sink with an entry it never buffered. Swallowing your own failure is
    // the one thing a destination must not do (§3).
    this.buffer.push(JSON.parse(payload) as Record<string, unknown>)
    if (this.buffer.length >= (this.opts.batchSize ?? 50)) this.flushInBackground()
  }

  // A DETACHED promise that rejects is an unhandled rejection, which terminates
  // the process on Node 24 — so the background path swallows what `flush` already
  // retained and reported. Chained rather than parallel, and retained in
  // `inFlight` so shutdown can await it. `onShutdown` awaits `flush` directly
  // afterwards, where a rejection has somewhere to go: the registry isolates it.
  private flushInBackground(): void {
    this.inFlight = this.inFlight.then(() => this.flush()).catch(() => undefined)
  }

  // A batch flush runs AFTER the `write` that triggered it has returned, so its
  // failure cannot reach the adapter — this is the one place a destination has to
  // handle its own. It still must not discard the batch: an empty `catch` here
  // loses every entry in it while the adapter has already recorded them as taken.
  // Put the batch back and report; the next flush retries it.
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    try {
      await this.prisma.log.createMany({
        data: batch.map((entry) => ({
          level: String(entry.level ?? 'info'),
          message: String(entry.msg ?? ''),
          logKey: String(entry.logKey ?? 'unknown'),
          metadata: entry,
          timestamp: new Date(Number(entry.time))
        })),
        skipDuplicates: true
      })
    } catch (err) {
      this.buffer.unshift(...batch)
      // Guard this write yourself — see the EPIPE note in §3. `writeStderrSafely`
      // is internal to the library and not importable from outside it.
      reportToStderrSafely(
        JSON.stringify({
          level: 'error',
          logKey: 'LOGGER_DESTINATION_WRITE_FAILED',
          destination: 'postgres',
          retained: batch.length,
          error: err instanceof Error ? err.message : String(err)
        }) + '\n'
      )
      throw err
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    // Wait for a background flush already running before draining what is left:
    // it may requeue its batch on failure, and those entries would otherwise be
    // stranded in a buffer nobody drains again.
    await this.inFlight
    // NOT swallowed: the registry catches, reports and isolates a failing
    // `onShutdown`, and a batch lost at shutdown is one nobody else is holding.
    await this.flush()
  }
}
```

> **Warning**: persisting logs in an RDBMS works for low volumes (≤ 1k entries/min). For high volumes, use Loki or ClickHouse.

---

## 6. Anti-patterns

❌ **Synchronous `write()` that performs blocking I/O** (e.g., `fs.writeFileSync`)
❌ **Catching and swallowing your own failure** — the adapter can only contain and RECORD what reaches it; a hidden failure lets readiness credit a sink that dropped the entry
❌ **Logging via the logger itself inside `write`** — infinite loop
❌ **Mutating the `payload`** — other destinations receive the same string
❌ **Assuming a rejected promise is ignored** — it is not: the adapter awaits it, records the failure and reports it, which is why it must not be swallowed first
❌ **Forgetting `onShutdown`** — loses the final batch on deploy
❌ **Sharing a buffer across multiple destinations** — race conditions

---

## 7. Testing destinations

### AAA test pattern

```typescript
describe('LokiDestination', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock
  })

  it('batches up to batchSize before flushing', async () => {
    // Arrange
    const dest = new LokiDestination({
      url: 'http://loki/api/push',
      batchSize: 3,
      flushIntervalMs: 60_000
    })
    dest.onInit()

    // Act
    dest.write('{"a":1}\n')
    dest.write('{"a":2}\n')
    expect(fetchMock).not.toHaveBeenCalled()
    dest.write('{"a":3}\n')
    await new Promise(setImmediate) // wait for flush promise

    // Assert
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://loki/api/push',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('flushes on shutdown', async () => {
    // ... same ...
  })

  it('fails soft on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const dest = new LokiDestination({ url: 'http://loki/api/push', batchSize: 1 })
    dest.onInit()
    // Trigger flush via public API: write batchSize entries OR call onShutdown
    dest.write('{"a":1}\n') // batchSize=1 → flush
    await expect(dest.onShutdown()).resolves.toBeUndefined() // does not re-throw
  })
})
```

### E2E with Testcontainers

For high confidence, run the destination against a **real Loki/Datadog** via Testcontainers:

```typescript
import { GenericContainer } from 'testcontainers'

describe('LokiDestination (E2E)', () => {
  let container: StartedTestContainer

  beforeAll(async () => {
    container = await new GenericContainer('grafana/loki:latest').withExposedPorts(3100).start()
  })

  afterAll(() => container.stop())

  it('actually delivers logs to Loki', async () => {
    const dest = new LokiDestination({
      url: `http://localhost:${container.getMappedPort(3100)}/loki/api/v1/push`
    })
    // ... ...
  })
})
```

---

## 8. Performance budget

Each destination ADDS latency to the critical logging path:

| Destination type  | Typical per-log latency                           | Strategy                |
| ----------------- | ------------------------------------------------- | ----------------------- |
| stdout JSON       | ~5 µs                                             | Sync OK                 |
| File (sonic-boom) | ~10 µs                                            | Async via thread-stream |
| HTTP (Loki batch) | negligible (<1 µs amortized on the critical path) | Batch + flush           |
| Postgres (Prisma) | negligible (<1 µs amortized on the critical path) | Batch + flush           |

**Golden rule**: `write()` must be O(1) (push to buffer). I/O operations happen in batches inside `flush()`.

---

## 9. Test checklist

For EVERY published destination:

- [ ] Unit test covers `write()` happy path (1 entry, multiple entries, malformed)
- [ ] Unit test covers `onInit()` (resource setup, idempotent if called twice)
- [ ] Unit test covers `onShutdown()` (flush + cleanup)
- [ ] Unit test covers fail-soft: `write` or `flush` receives an error → does NOT re-throw
- [ ] Race condition test: 1000 concurrent writes → all reach the buffer/output
- [ ] Backpressure test (if applicable): buffer full → predictable behavior (drop oldest? block? warn?)
- [ ] E2E (optional, recommended for HTTP/DB): real roundtrip via Testcontainers
- [ ] 100% coverage in `*.destination.ts` and specs
- [ ] 100% mutation score (no gaps on critical paths)

---

## 10. Worker-thread caveats — `thread-stream` & `transport`

`pino.transport({ target: ... })` runs the destination in a **worker thread** (via `thread-stream`) to keep the main event loop free. This isolation has sharp edges every destination author must understand:

- **ALS context does NOT cross the worker boundary.** `LogContextService` (built on `AsyncLocalStorage`) is bound to the main thread. Logs written from inside a worker-thread destination will **miss** `requestId` / `tenantId` / `userId` UNLESS those fields were already merged into the log object on the main thread (i.e. the lib's mixin ran before serialization). The mixin always runs main-thread — so as long as the destination receives the JSON payload as produced by Pino, contextual fields are preserved. Custom destinations that re-derive context inside the worker will get an empty store.
- **TypeScript source files cannot be `require()`'d from the worker** unless they have been transpiled. Point worker `target` at a built `.js` file (e.g., `target: require.resolve('./my-destination.js')`), never at the `.ts` source. Bundlers must emit the worker entrypoint as a separate, standalone artifact.
- **No shared state between main and worker.** Connection pools, in-memory caches, and singletons must be re-initialized inside the worker. Pass config via the `target` options object (serialized to JSON).
- **Crash semantics.** A throw in the worker terminates the worker thread; `thread-stream` reconnects but already-buffered logs are lost. Always pair worker destinations with shutdown hooks that drain main-thread queues first.

**Recommendation:** keep built-in destinations (stdout, file, pretty) on the **main thread** — overhead is negligible. Reserve `pino.transport` for opt-in async sinks (Loki, S3, Kafka) where serialization + I/O cost justifies a separate event loop.

---

## References

- [Pino multistream docs](https://github.com/pinojs/pino/blob/main/docs/api.md#pinomultistreamstreamsarray-opts--multistreamres)
- [sonic-boom](https://github.com/pinojs/sonic-boom)
- [thread-stream](https://github.com/pinojs/thread-stream)
- [Loki API push](https://grafana.com/docs/loki/latest/reference/api/#push-log-entries-to-loki)
- [Testcontainers Node](https://node.testcontainers.org/)
