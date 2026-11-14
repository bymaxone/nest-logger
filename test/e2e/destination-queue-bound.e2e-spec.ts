/**
 * E2E: the queue each destination holds is bounded, through a real Nest application.
 *
 * Pino hands every entry to a destination's `Writable` whether or not the destination has taken the
 * last one, so a destination slower than the application queues without limit. These cases log a
 * burst into a destination that takes a few milliseconds per entry and read what it received, what
 * stderr said, and what the final tally was.
 *
 * Layer: E2E, server (`destinationToStream`, `DestinationRegistry`).
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'

const LINES = 5000
const MAX_BYTES = 64 * 1024

/** A destination that takes `ms` per write and keeps what it was given. */
function slowDestination(ms: number): {
  readonly destination: { name: string; write(line: string): Promise<void> }
  readonly received: string[]
} {
  const received: string[] = []
  return {
    received,
    destination: {
      name: 'slow',
      async write(line: string): Promise<void> {
        received.push(line)
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
      }
    }
  }
}

describe('Logger E2E — the queue of a slow destination is bounded', () => {
  let app: INestApplicationContext | undefined
  let stderr: jest.SpyInstance

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
    jest.restoreAllMocks()
  })

  /** Boot the module over one destination and log the burst. */
  async function logBurst(
    destination: { name: string; write(line: string): Promise<void> },
    destinationQueue: { maxBytes: number }
  ): Promise<void> {
    app = await NestFactory.createApplicationContext(
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-queue-bound', version: '0.0.0' },
        destinations: [destination],
        destinationQueue,
        shutdown: { timeoutMs: 1500, drainTimeoutMs: 1000 }
      }),
      { logger: false }
    )
    const logger = app.get(PinoLoggerService)
    for (let i = 0; i < LINES; i += 1) logger.info('K', `line ${String(i)}`, 'u', { i })
  }

  const stderrText = (): string => stderr.mock.calls.map((call) => String(call[0])).join('')

  it('drops the entries that do not fit and says so once, with no entry content', async () => {
    const { destination, received } = slowDestination(2)

    await logBurst(destination, { maxBytes: MAX_BYTES })
    await app?.close()
    app = undefined

    const delivered = received.join('')
    expect(Buffer.byteLength(delivered)).toBeLessThan(MAX_BYTES * 2)
    expect(received.length).toBeLessThan(LINES)
    expect(stderrText().match(/queue full/g)).toHaveLength(1)
    expect(stderrText()).toContain('"slow"')
    expect(stderrText()).not.toContain('line 4999')
  })

  it('writes a final tally of the dropped entries at shutdown', async () => {
    const { destination } = slowDestination(2)

    await logBurst(destination, { maxBytes: MAX_BYTES })
    await app?.close()
    app = undefined

    expect(stderrText()).toMatch(/dropped \d+ entries in total/)
  })

  it('keeps every entry when the bound is 0, which turns it off', async () => {
    const { destination, received } = slowDestination(0)

    await logBurst(destination, { maxBytes: 0 })
    await app?.close()
    app = undefined

    expect(received.length).toBeGreaterThanOrEqual(LINES)
    expect(stderrText()).not.toContain('queue full')
  })
})
