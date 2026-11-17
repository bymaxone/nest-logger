/**
 * Pins how a plain object handed to the NestJS variadic methods, and the metadata of the structured
 * methods, are written: the keys the entry owns are never taken from the caller, a look-alike key
 * is kept, and the text of an object message comes from its `message` or `event` string and is
 * written once. Driven through the real Pino pipeline, so the assertions are on the line that
 * reaches a destination.
 *
 * Layer: server/services, tests. Kept apart from the service's own spec, which is near the size
 * limit.
 */
import { applyDefaults } from '../config/default-options'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from './destination-health.service'
import { LogContextService } from './log-context.service'
import { PinoLoggerService } from './pino-logger.service'

/** A logger over the real factory whose destination captures each line. */
function createPipeline(): {
  service: PinoLoggerService
  lines(): string[]
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({
    service: { name: 'app', version: '1.0.0', environment: 'prod' }
  })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino),
    lines: () => lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

const FORGED = 'forged-value'

describe('the keys an entry owns', () => {
  const owned = [
    'level',
    'time',
    'msg',
    'service',
    'deployment',
    'service.name',
    'service.instance.id',
    'deployment.environment.name',
    'logKey',
    'userId',
    'context'
  ]

  it.each(owned)('%s is not taken from an object message', (key) => {
    const { service, lines } = createPipeline()

    service.warn({ event: 'LIB_EVENT', [key]: FORGED })

    expect(lines()).toHaveLength(1)
    expect(lines().join('')).not.toContain(FORGED)
  })

  it.each(owned)('%s is not taken from the metadata of a structured call', (key) => {
    const { service, lines } = createPipeline()

    service.info('LIB_EVENT', 'text', undefined, { [key]: FORGED })

    expect(lines()).toHaveLength(1)
    expect(lines().join('')).not.toContain(FORGED)
  })

  /*
   * A key that only resembles an owned one is data: the guard is on the name, not on a substring,
   * a suffix or a prefix of it.
   */
  it.each([
    'services',
    'serviceName',
    'deployments',
    'deploymentId',
    'xservice.name',
    'my.deployment.name',
    'levelName',
    'timestamp'
  ])('%s is kept as a field', (key) => {
    const { service, entries } = createPipeline()

    service.warn({ event: 'LIB_EVENT', [key]: 'kept' })

    expect(entries()[0]).toHaveProperty([key], 'kept')
  })
})

describe('the text of an object message', () => {
  it('is the message string, which is not written again as a field', () => {
    const { service, entries } = createPipeline()

    service.log({ message: 'queue drained', event: 'LIB_DRAINED' })

    expect(entries()[0]).toMatchObject({ msg: 'queue drained', event: 'LIB_DRAINED' })
    expect(entries()[0]).not.toHaveProperty('message')
  })

  it('is the event string when the message is not a string, and the message stays a field', () => {
    const { service, entries } = createPipeline()

    service.log({ message: { not: 'text' }, event: 'LIB_EVENT' })

    expect(entries()[0]).toMatchObject({ msg: 'LIB_EVENT', message: { not: 'text' } })
  })

  it('is empty when neither member is a string, and the message stays a field', () => {
    const { service, entries } = createPipeline()

    service.log({ message: 7, attempts: 3 })

    expect(entries()[0]).toMatchObject({ msg: '', message: 7, attempts: 3 })
  })

  it('is read as no fields for a value that is not a plain object', () => {
    const { service, entries } = createPipeline()
    class Dto {
      readonly attempts = 3
      readonly event = 'LIB_EVENT'
    }

    service.log(new Dto())
    service.log(['a', 'b'])

    expect(entries()[0]).toMatchObject({ msg: '[object Object]' })
    expect(entries()[0]).not.toHaveProperty('attempts')
    expect(entries()[1]).toMatchObject({ msg: 'a,b' })
  })
})
