/**
 * Pins that every field the logger cuts or replaces for a size bound is counted, under the reason
 * for it and under no other: a string cut at `maxStringLength`, a serializer output over
 * `maxEntrySizeBytes` or one that cannot be measured, and a derived exception field cut to it.
 * Driven through the real factory, so the counts are those a scrape would read.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

function create(extra: Partial<BymaxLoggerModuleOptions>): {
  service: PinoLoggerService
  health: DestinationHealth
} {
  const destination: ILogDestination = { name: 'capture', write: () => undefined }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const health = new DestinationHealth()
  const pino = buildPinoInstance(options, new LogContextService(), [destination], health)
  return { service: new PinoLoggerService(pino), health }
}

const totals = (health: DestinationHealth): [number, number] => [
  health.truncatedTotal('max_entry_size'),
  health.truncatedTotal('max_string_length')
]

describe('the size bounds count what they cut', () => {
  it('counts nothing when nothing is cut', () => {
    const { service, health } = create({ maxStringLength: 64, serializers: { thing: (v) => v } })

    service.info('SMALL', 'text', undefined, { note: 'short', thing: { a: 1 } })

    expect(totals(health)).toEqual([0, 0])
  })

  it('counts each string cut at maxStringLength, under max_string_length', () => {
    const { service, health } = create({ maxStringLength: 64 })

    service.info('LONG', 'text', undefined, {
      first: 'x'.repeat(100),
      second: 'y'.repeat(100),
      short: 'ok',
      nested: { deep: 'z'.repeat(100) }
    })

    expect(totals(health)).toEqual([0, 3])
  })

  it('counts a serializer output over the ceiling, under max_entry_size', () => {
    const { service, health } = create({
      maxEntrySizeBytes: 1024,
      serializers: { thing: (value: unknown) => value }
    })

    service.info('BIG', 'text', undefined, { thing: { blob: 'x'.repeat(5000) } })

    expect(totals(health)).toEqual([1, 0])
  })

  it('counts each derived exception field cut to the ceiling, under max_entry_size', () => {
    const { service, health } = create({ maxEntrySizeBytes: 1024, errorFormat: 'both' })
    const error = new Error('m'.repeat(5000))
    error.stack = `Error: ${'s'.repeat(5000)}\n    at a (f.js:1:1)`

    service.error(error)

    // exception.message and exception.stacktrace are cut; the type and the short name are not. The
    // err serializer output is over the ceiling too and is counted once.
    expect(health.truncatedTotal('max_entry_size')).toBeGreaterThanOrEqual(2)
    expect(health.truncatedTotal('max_string_length')).toBe(0)
  })

  it('does not count a derived field that fits the ceiling', () => {
    const { service, health } = create({ errorFormat: 'both' })

    service.error(new Error('short'))

    expect(totals(health)).toEqual([0, 0])
  })
})
