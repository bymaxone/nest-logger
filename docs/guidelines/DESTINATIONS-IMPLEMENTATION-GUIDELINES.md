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
  write(payload: string): void | Promise<void>

  /** Called once at NestJS bootstrap. */
  onInit?(): void | Promise<void>

  /** Called at NestJS shutdown. MUST flush + close resources. */
  onShutdown?(): void | Promise<void>
}
```

**Principles:**

- `write` receives a **serialized JSON string** — the destination does not need to parse it (but may).
- `write` is the **hot path** — any extra allocation impacts throughput.
- `onInit` / `onShutdown` are optional; the presence of both ensures proper lifecycle.

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

export function destinationToStream(dest: ILogDestination): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const result = dest.write(chunk.toString('utf8'))
        if (result instanceof Promise) {
          result.then(
            () => callback(),
            (err) => callback(err as Error)
          )
        } else {
          callback()
        }
      } catch (err) {
        callback(err as Error)
      }
    }
  })
}
```

Advantages:

- Destinations do not need to extend `Writable` manually
- Errors are propagated as a callback err (not as an exception that crashes the app)
- Async `write` is supported transparently

---

## 3. Backpressure and fail-soft

### Backpressure

`sonic-boom` (Pino's stream engine) emits `'drain'` events when its internal buffer fills up. Destinations that send to the network (Loki, Datadog) MUST buffer internally and flush in batches.

**Drain contract for our adapter:** when `Writable._write` returns `false`, Pino's multistream pauses; on `'drain'`, it resumes. Our `destinationToStream()` adapter's `_write` only returns `false` (implicitly, by deferring `callback`) if `dest.write()` returns a `Promise` that is not yet resolved — sync destinations (stdout, file) never trigger backpressure on the Pino side. This is an intentional contract: synchronous destinations are expected to never block; async destinations opt into backpressure via Promise resolution.

```typescript
// Inside destinationToStream — Promise-returning write defers callback,
// which signals backpressure upstream until the Promise resolves.
write(chunk, _enc, callback) {
  const result = dest.write(chunk.toString('utf8'))
  if (result instanceof Promise) result.then(() => callback(), (err) => callback(err))
  else callback()
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

  onInit(): void {
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 5000)
  }

  write(payload: string): void {
    this.buffer.push(payload)
    if (this.buffer.length >= (this.opts.batchSize ?? 100)) {
      void this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    try {
      await fetch(this.opts.url, { method: 'POST', body: this.formatLokiPush(batch) })
    } catch {
      // Fail soft — log delivery failure MUST NOT crash the app
      // In critical production: pair with a dead-letter queue or alert
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
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

A destination that **throws** in `write()` breaks Pino multi-stream — a failure in one destination MUST NOT affect the others. **Principle**: catch every error in `write` (try/catch) and log it via `process.stderr.write` only. Never via the logger itself (infinite loop).

---

## 4. Lifecycle

| Hook         | When                                   | What to do                                             |
| ------------ | -------------------------------------- | ------------------------------------------------------ |
| `onInit`     | NestJS bootstrap, before the first log | Open connections, start flush timer, validate config   |
| `write`      | Every log                              | Push to internal buffer; flush in batch if ≥ batchSize |
| `onShutdown` | NestJS `SIGTERM` / `app.close()`       | Stop timers, flush remaining buffer, close connections |

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
      process.stderr.write(`Destination "${dest.name}" shutdown failed: ${err}\n`)
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

```typescript
import pretty from 'pino-pretty'

export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  private readonly stream = pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l' })

  constructor() {
    this.stream.pipe(process.stdout)
  }

  write(payload: string): void {
    this.stream.write(payload)
  }

  onShutdown(): void {
    this.stream.end()
  }
}
```

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

  onInit(): void {
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 2000)
  }

  write(payload: string): void {
    try {
      this.buffer.push(JSON.parse(payload) as Record<string, unknown>)
      if (this.buffer.length >= (this.opts.batchSize ?? 50)) void this.flush()
    } catch (e) {
      // Emit reserved key so the failure is searchable in dashboards
      process.stderr.write(
        JSON.stringify({
          level: 'error',
          logKey: 'LOGGER_DESTINATION_WRITE_FAILED',
          destination: 'postgres',
          error: (e as Error).message
        }) + '\n'
      )
    }
  }

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
    } catch {
      /* fail-soft */
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    await this.flush()
  }
}
```

> **Warning**: persisting logs in an RDBMS works for low volumes (≤ 1k entries/min). For high volumes, use Loki or ClickHouse.

---

## 6. Anti-patterns

❌ **Synchronous `write()` that performs blocking I/O** (e.g., `fs.writeFileSync`)
❌ **`write()` that throws an exception** — stops Pino multi-stream (use a callback err instead)
❌ **Logging via the logger itself inside `write`** — infinite loop
❌ **Mutating the `payload`** — other destinations receive the same string
❌ **Expecting `write` to accept a rejected Promise as an error** — catch and log via stderr
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
