/**
 * Pins the bound `destinationToStream` puts on a destination's queue: what is dropped, what is
 * counted, what is reported and what is left alone.
 *
 * Layer: server/utils, tests. The destinations are doubles whose writes the case settles by hand, so
 * the queue is whatever the case has not released.
 */
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { DROP_REPORT_INTERVAL_MS, DestinationHealth } from '../services/destination-health.service'

import { destinationToStream } from './destination-to-stream'

/** A destination whose writes stay in flight until `release` is called. */
function stalledDestination(extra: Partial<ILogDestination> = {}): {
  readonly destination: ILogDestination
  readonly seen: string[]
  readonly release: () => void
} {
  const seen: string[] = []
  const releases: Array<() => void> = []
  return {
    seen,
    release: (): void => {
      for (const release of releases.splice(0)) release()
    },
    destination: {
      name: 'stalled',
      write(payload: string): Promise<void> {
        seen.push(payload)
        return new Promise<void>((resolve) => releases.push(resolve))
      },
      ...extra
    }
  }
}

describe('destinationToStream, the queue bound', () => {
  let stderr: jest.SpyInstance
  let health: DestinationHealth

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const stderrText = (): string => stderr.mock.calls.map((call) => String(call[0])).join('')

  it('accepts entries up to the bound and drops the one that would pass it', () => {
    const { destination, seen } = stalledDestination()
    const stream = destinationToStream(destination, health, 100)

    stream.write('a'.repeat(40))
    stream.write('b'.repeat(40))
    stream.write('c'.repeat(40))

    expect(stream.queuedBytes).toBe(80)
    expect(seen).toEqual(['a'.repeat(40)])
    expect(health.droppedTotal(destination)).toBe(1)
  })

  it('counts bytes, not characters, so multi-byte text cannot overshoot the bound', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health, 100)
    const threeBytes = '€'.repeat(20)

    stream.write(threeBytes)
    stream.write(threeBytes)

    expect(Buffer.byteLength(threeBytes)).toBe(60)
    expect(stream.queuedBytes).toBe(60)
    expect(health.droppedTotal(destination)).toBe(1)
  })

  it('calls the callback of a dropped entry, so the producer sees a completed write', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health, 50)
    const callback = jest.fn()
    stream.write('x'.repeat(40))

    const accepted = stream.write('y'.repeat(40), callback)
    const acceptedWithEncoding = stream.write('z'.repeat(40), 'utf8', callback)

    expect(accepted).toBe(true)
    expect(acceptedWithEncoding).toBe(true)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(health.droppedTotal(destination)).toBe(2)
  })

  it('accepts one entry larger than the bound when nothing is queued', () => {
    const { destination, seen } = stalledDestination()
    const stream = destinationToStream(destination, health, 10)

    stream.write('x'.repeat(40))
    stream.write('y')

    expect(seen).toEqual(['x'.repeat(40)])
    expect(stream.queuedBytes).toBe(40)
    expect(health.droppedTotal(destination)).toBe(1)
  })

  it('releases the bytes of a write when it settles, so later entries are accepted again', async () => {
    const { destination, seen, release } = stalledDestination()
    const stream = destinationToStream(destination, health, 100)
    stream.write('a'.repeat(60))
    release()
    await new Promise((resolve) => setImmediate(resolve))

    stream.write('b'.repeat(60))

    expect(stream.queuedBytes).toBe(60)
    expect(seen).toHaveLength(2)
    expect(health.droppedTotal(destination)).toBe(0)
  })

  it('counts what the destination reports it holds in a buffer of its own', () => {
    const { destination, seen } = stalledDestination({ queuedBytes: () => 90 })
    const stream = destinationToStream(destination, health, 100)

    stream.write('x'.repeat(20))

    expect(seen).toEqual([])
    expect(health.droppedTotal(destination)).toBe(1)
  })

  it.each([
    [
      'throws',
      (): number => {
        throw new Error('hostile')
      }
    ],
    ['is not a number', (): number => 'many' as unknown as number],
    ['is negative', (): number => -5],
    ['is infinite', (): number => Number.POSITIVE_INFINITY]
  ])('counts a queuedBytes that %s as zero', (_name, queuedBytes) => {
    const { destination, seen } = stalledDestination({ queuedBytes })
    const stream = destinationToStream(destination, health, 100)

    stream.write('x'.repeat(20))

    expect(seen).toEqual(['x'.repeat(20)])
    expect(health.droppedTotal(destination)).toBe(0)
  })

  it('has no bound at 0, and still counts the bytes it holds', () => {
    const { destination, seen } = stalledDestination()
    const stream = destinationToStream(destination, health, 0)

    for (let i = 0; i < 100; i += 1) stream.write('x'.repeat(1000))

    expect(seen).toHaveLength(1)
    expect(stream.queuedBytes).toBe(100_000)
    expect(health.droppedTotal(destination)).toBe(0)
  })

  it('has no bound when none is given', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health)

    stream.write('x'.repeat(5000))
    stream.write('y'.repeat(5000))

    expect(health.droppedTotal(destination)).toBe(0)
  })

  it('writes one report for the first drop, with the name and the limit and no entry content', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health, 50)
    stream.write('x'.repeat(40))

    stream.write('SECRET-ENTRY-TEXT-' + 'y'.repeat(30))
    stream.write('SECRET-ENTRY-TEXT-' + 'z'.repeat(30))

    expect(stderrText().match(/queue full/g)).toHaveLength(1)
    expect(stderrText()).toContain('"stalled"')
    expect(stderrText()).toContain('1 entries dropped since the last report (limit 50 bytes)')
    expect(stderrText()).not.toContain('SECRET')
  })

  it('writes a destination name that is not text safely on one line', () => {
    const { destination } = stalledDestination()
    Object.defineProperty(destination, 'name', { value: 'a\nb', enumerable: true })
    const stream = destinationToStream(destination, health, 10)
    stream.write('x'.repeat(40))

    stream.write('y')

    expect(
      stderrText()
        .split('\n')
        .filter((line) => line.includes('queue full'))
    ).toHaveLength(1)
  })

  it('does not count a write to an ended or destroyed stream, which is refused without a release', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health, 4096)
    stream.on('error', () => undefined)

    stream.destroy()
    stream.write('abcdef\n')

    expect(stream.queuedBytes).toBe(0)
  })

  it('releases the bytes of entries buffered behind a write in flight when the stream is destroyed', async () => {
    const releases: Array<() => void> = []
    const destination: ILogDestination = {
      name: 'slow',
      write: () => new Promise<void>((resolve) => releases.push(resolve))
    }
    const stream = destinationToStream(destination, health, 4096)
    stream.on('error', () => undefined)
    stream.write('aaaa\n')
    stream.write('bbbb\n')
    stream.write('cccc\n')
    expect(stream.queuedBytes).toBe(15)

    stream.destroy()
    await new Promise((resolve) => setImmediate(resolve))

    expect(stream.queuedBytes).toBe(0)
    for (const release of releases) release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(stream.queuedBytes).toBe(0)
  })

  it('does not count a write after end either', () => {
    const { destination } = stalledDestination()
    const stream = destinationToStream(destination, health, 4096)
    stream.on('error', () => undefined)

    stream.end()
    stream.write('abcdef\n')

    expect(stream.queuedBytes).toBe(0)
  })

  it('never drops for a failed destination that is not the rescuer, whatever it reports', () => {
    const { destination } = stalledDestination({ queuedBytes: () => 1000 })
    health.markFailed(destination, 'info')
    health.markHealthy({ name: 'other', write: jest.fn() }, 'info')
    const stream = destinationToStream(destination, health, 100)

    stream.write('x'.repeat(40))
    stream.write('y'.repeat(40))

    expect(health.droppedTotal(destination)).toBe(0)
  })

  it('bounds the elected rescuer on the module queue and on what process.stdout holds', () => {
    const { destination } = stalledDestination({ queuedBytes: () => 1000 })
    health.markFailed(destination, 'info')
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    Object.defineProperty(process.stdout, 'writableLength', { value: 90, configurable: true })

    try {
      const stream = destinationToStream(destination, health, 100)
      stream.write('x'.repeat(5))
      stream.write('y'.repeat(40))

      expect(stdoutWrite).toHaveBeenCalledTimes(1)
      expect(health.droppedTotal(destination)).toBe(1)
    } finally {
      Reflect.deleteProperty(process.stdout, 'writableLength')
    }
  })

  it('does not drop for a failed destination, which the stream already skips', () => {
    const { destination, seen } = stalledDestination()
    health.markFailed(destination, 'info')
    const stream = destinationToStream(destination, health, 10)

    stream.write('x'.repeat(40))
    stream.write('y'.repeat(40))

    expect(seen).toEqual([])
    expect(stream.queuedBytes).toBe(0)
    expect(health.droppedTotal(destination)).toBe(0)
  })
})

describe('DestinationHealth, the drop record', () => {
  const destination: ILogDestination = { name: 'd', write: jest.fn() }

  it('reports the first drop at once, then at most once per window with the count since', () => {
    const health = new DestinationHealth()

    expect(health.recordDrop(destination, 0)).toBe(1)
    expect(health.recordDrop(destination, 1)).toBeUndefined()
    expect(health.recordDrop(destination, DROP_REPORT_INTERVAL_MS - 1)).toBeUndefined()
    expect(health.recordDrop(destination, DROP_REPORT_INTERVAL_MS)).toBe(3)
    expect(health.recordDrop(destination, DROP_REPORT_INTERVAL_MS + 1)).toBeUndefined()
    expect(health.droppedTotal(destination)).toBe(5)
  })

  it('keeps one record per destination, and zero for one that never dropped', () => {
    const health = new DestinationHealth()
    const other: ILogDestination = { name: 'o', write: jest.fn() }

    health.recordDrop(destination, 0)

    expect(health.droppedTotal(other)).toBe(0)
    expect(health.queuedSize(other)).toBe(0)
  })
})
