/**
 * Pins how often a destination that refuses writes is reported: the first failure at once, the rest
 * of its window counted and said on the first failure after it, and every failure still recorded
 * for readiness. A sustained refusal must cost one stderr line per window, not one per entry.
 *
 * Layer: server/utils, tests. The clock is scripted, so no case waits for a window to pass.
 */
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { DROP_REPORT_INTERVAL_MS, DestinationHealth } from '../services/destination-health.service'

import { destinationToStream } from './destination-to-stream'

/** A destination whose every write throws. */
function refusing(name: string): ILogDestination & { readonly calls: () => number } {
  let calls = 0
  return {
    name,
    write(): void {
      calls += 1
      throw new Error('refused')
    },
    calls: () => calls
  }
}

describe('destinationToStream, the write-failure report', () => {
  let stderr: jest.SpyInstance
  let health: DestinationHealth
  let clock: number

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
    clock = 1000
    jest.spyOn(performance, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const reports = (): Array<Record<string, unknown>> =>
    stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('LOGGER_DESTINATION_WRITE_FAILED'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  it('reports the first failure at once and counts the rest of the window', () => {
    const destination = refusing('flooded')
    const stream = destinationToStream(destination, health)

    for (let i = 0; i < 1000; i += 1) stream.write(`entry ${String(i)}\n`)

    expect(destination.calls()).toBe(1000)
    expect(reports()).toHaveLength(1)
    expect(Object.keys(reports()[0] ?? {})).not.toContain('suppressed')
  })

  it('says how many were not reported on the first failure after the window', () => {
    const destination = refusing('flooded')
    const stream = destinationToStream(destination, health)
    for (let i = 0; i < 1000; i += 1) stream.write('x\n')

    clock += DROP_REPORT_INTERVAL_MS
    stream.write('after the window\n')

    expect(reports()).toHaveLength(2)
    expect(reports()[1]?.['suppressed']).toBe(999)
  })

  it('keeps a window open until the full interval has passed', () => {
    const stream = destinationToStream(refusing('flooded'), health)
    stream.write('first\n')

    clock += DROP_REPORT_INTERVAL_MS - 1
    stream.write('inside\n')

    expect(reports()).toHaveLength(1)
  })

  it('counts each destination on its own', () => {
    const a = destinationToStream(refusing('a'), health)
    const b = destinationToStream(refusing('b'), health)

    a.write('x\n')
    a.write('x\n')
    b.write('x\n')

    expect(reports().map((r) => r['destination'])).toEqual(['a', 'b'])
  })

  it('still records every failure for readiness, reported or not', () => {
    const destination = refusing('flooded')
    const stream = destinationToStream(destination, health)
    for (let i = 0; i < 5; i += 1) stream.write('x\n')

    expect(health.failedWriteTotal(destination)).toBe(5)
    const other: ILogDestination = { name: 'other', write: jest.fn() }
    health.markHealthy(destination, 'info')
    health.markHealthy(other, 'info')
    expect(health.deliveredByHealthySink(other, 'info')).toBe(false)
  })

  it('names the cause and the entry loss on every line, and never the entry', () => {
    const stream = destinationToStream(refusing('flooded'), health)

    stream.write('SECRET-ENTRY\n')

    const [line] = reports()
    expect(line?.['msg']).toContain('the entry was dropped')
    expect(JSON.stringify(line)).not.toContain('SECRET-ENTRY')
  })
})
