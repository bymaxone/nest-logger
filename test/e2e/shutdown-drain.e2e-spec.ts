/**
 * E2E: the queue of a slow destination is drained before its `onShutdown` runs, through a real Nest
 * application.
 *
 * Each destination sits behind a `Writable` that holds the entries Pino has written but the
 * destination has not yet taken. `onShutdown` is the destination's signal to flush and close, so a
 * write that begins after it is a write on a closed resource. These cases log a burst into a
 * destination that takes a few milliseconds per entry, close the application, and read the order in
 * which the destination saw its writes and its shutdown.
 *
 * Layer: E2E, server (`DestinationRegistry`, `destinationToStream`).
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'

const LINES = 300

/** A destination that takes `ms` per write and records what it saw, in order. */
function slowDestination(ms: number): {
  readonly destination: {
    name: string
    write(line: string): Promise<void>
    onShutdown(): Promise<void>
  }
  readonly seen: { started: number; startedAfterShutdown: number; finished: number; down: boolean }
} {
  const seen = { started: 0, startedAfterShutdown: 0, finished: 0, down: false }
  return {
    seen,
    destination: {
      name: 'slow',
      async write(): Promise<void> {
        seen.started += 1
        if (seen.down) seen.startedAfterShutdown += 1
        await new Promise((resolve) => setTimeout(resolve, ms))
        seen.finished += 1
      },
      async onShutdown(): Promise<void> {
        seen.down = true
      }
    }
  }
}

describe('Logger E2E — the destination queue is drained before onShutdown', () => {
  let app: INestApplicationContext | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('starts every write before the destination is told to shut down', async () => {
    const { destination, seen } = slowDestination(5)
    app = await NestFactory.createApplicationContext(
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-shutdown-drain', version: '0.0.0' },
        destinations: [destination]
      }),
      { logger: false }
    )
    const logger = app.get(PinoLoggerService)
    for (let i = 0; i < LINES; i += 1) logger.info('K', `line ${String(i)}`, 'u', { i })

    await app.close()
    app = undefined
    // Long enough for the whole queue to run out on its own, if close() did not wait for it.
    await new Promise((resolve) => setTimeout(resolve, LINES * 8))

    expect(seen.startedAfterShutdown).toBe(0)
    expect(seen.finished).toBe(seen.started)
    expect(seen.started).toBeGreaterThanOrEqual(LINES)
  })
})
