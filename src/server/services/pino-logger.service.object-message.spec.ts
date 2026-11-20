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
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { buildPinoInstance, resolveNameRedactor } from '../pino-factory'
import { createEntryTextFinisher, ENTRY_TEXT_FINISHER } from '../utils/entry-text-finisher.util'
import type { Redactor } from '../utils/redact-by-name.util'
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
    'service_name',
    'serviceName',
    'service-version',
    'service.instance_id',
    'deployment_environment_name',
    'servi\u0441e.name',
    'service.region',
    'Service.Region',
    'deployment.region',
    'Deployment.Region',
    'log key',
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
    'service_tier',
    'deployments',
    'deploymentId',
    'xservice.name',
    'my.deployment.name',
    'my.service.',
    'my.deployment.',
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

/** A pipeline over the module options given, with the redactor the module wires into the service. */
function createRedactingPipeline(extra: Partial<BymaxLoggerModuleOptions>): {
  service: PinoLoggerService
  entries(): Record<string, unknown>[]
  pino: ReturnType<typeof buildPinoInstance>
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  return {
    pino,
    service: new PinoLoggerService(pino, resolveNameRedactor(options)),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

describe('the censoring of the text of an object message', () => {
  it.each([
    ['names', 'event'],
    ['names', 'message'],
    ['paths', 'event'],
    ['paths', 'message']
  ] as const)(
    'censors the text taken from a field named in redactPaths (%s, %s)',
    (strategy, key) => {
      const { service, entries } = createRedactingPipeline({
        redactStrategy: strategy,
        redactPaths: [key]
      })

      service.warn({ [key]: 'secret-text-value' })

      expect(JSON.stringify(entries()[0])).not.toContain('secret-text-value')
    }
  )

  it('cuts the text at maxStringLength as it cuts its field', () => {
    const { service, entries } = createRedactingPipeline({ maxStringLength: 64 })

    service.warn({ event: 'x'.repeat(1000) })

    expect(entries()[0]?.['msg']).toBe('x'.repeat(64) + '…[truncated]')
    expect(entries()[0]?.['event']).toBe('x'.repeat(64) + '…[truncated]')
  })

  it('leaves the text alone when its field is not named', () => {
    const { service, entries } = createRedactingPipeline({ redactPaths: ['password'] })

    service.warn({ event: 'LIB_EVENT' })

    expect(entries()[0]).toMatchObject({ msg: 'LIB_EVENT' })
  })

  it('uses the redactor the service was built with when the instance carries none', () => {
    const { service, entries, pino } = createRedactingPipeline({})
    Reflect.deleteProperty(pino, ENTRY_TEXT_FINISHER)

    service.warn({ event: 'LIB_EVENT' })

    expect(entries()[0]).toMatchObject({ msg: 'LIB_EVENT' })
  })

  it.each([
    [
      'throws',
      (): never => {
        throw new Error('redactor exploded')
      }
    ],
    ['returns text that is not a string', (): unknown => ({ event: 1 })]
  ])('writes an empty text when the redactor %s', (_label, redactor) => {
    const { entries, pino } = createRedactingPipeline({})
    Reflect.set(
      pino,
      ENTRY_TEXT_FINISHER,
      createEntryTextFinisher(redactor as unknown as Redactor, undefined)
    )
    const service = new PinoLoggerService(pino)

    service.warn({ event: 'LIB_EVENT', attempts: 3 })

    expect(entries()[0]).toMatchObject({ msg: '', attempts: 3 })
  })

  it('writes an object that is shaped like an error as an error only', () => {
    const { service, entries } = createRedactingPipeline({ errorOwnFields: 'safe' })

    service.warn({ name: 'DriverError', message: 'failed', stdout: 'private-output' })

    expect(entries()[0]).toHaveProperty('err')
    expect(entries()[0]).not.toHaveProperty('stdout')
    expect(JSON.stringify(entries()[0])).not.toContain('private-output')
  })
})
