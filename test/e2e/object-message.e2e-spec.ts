/**
 * E2E: a plain object handed to the plain Nest `Logger` as the message of a call is written as the
 * fields of the entry, through the redaction and string-limit pipeline, with the entry text taken
 * from its `message` or `event` string. It is exercised the way an application does it: the logger
 * is installed with `app.useLogger` and a class that owns a Nest `Logger` makes the call.
 *
 * Layer: e2e, server (`PinoLoggerService`, the redaction walk, `maxStringLength`).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const LIMIT = 128

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

type Entry = Record<string, unknown>

/** An application that installs the library's logger, runs `act`, and returns the entries written after boot. */
async function run(
  act: (logger: Logger, service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<Entry[]> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-object-message', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.payloads.length
  act(new Logger('LibContext'), app.get(PinoLoggerService))
  await app.close()
  return collector.payloads
    .slice(booted)
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => !String(entry['logKey'] ?? '').startsWith('LOGGER_'))
}

/** The one entry the call wrote; a missing entry fails the case instead of passing on `undefined`. */
async function runOne(
  act: (logger: Logger, service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<Entry> {
  const entries = await run(act, extra)
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(`Expected one entry, got ${String(entries.length)}`)
  }
  return entry
}

/** The raw lines the call wrote, to look at keys that a parse would merge. */
async function runRaw(
  act: (logger: Logger, service: PinoLoggerService) => void
): Promise<string[]> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-object-message', version: '0.0.0' },
        destinations: [collector]
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.payloads.length
  act(new Logger('LibContext'), app.get(PinoLoggerService))
  await app.close()
  return collector.payloads.slice(booted).filter((line) => !line.includes('"LOGGER_'))
}

describe('Logger E2E — an object as the message', () => {
  it('writes the keys of the object as fields and the event as the entry text', async () => {
    const entry = await runOne((logger) =>
      logger.warn({ event: 'LIB_EVENT', attempts: 3, reason: 'timeout' })
    )

    expect(entry).toMatchObject({
      level: 'warn',
      context: 'LibContext',
      msg: 'LIB_EVENT',
      event: 'LIB_EVENT',
      attempts: 3,
      reason: 'timeout'
    })
  })

  it.each(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const)(
    'does it for every level: %s',
    async (method) => {
      const entry = await runOne((logger) => logger[method]({ event: 'LIB_EVENT', attempts: 3 }), {
        level: 'trace'
      })

      expect(entry).toMatchObject({ msg: 'LIB_EVENT', attempts: 3 })
    }
  )

  it('takes the entry text from a message string and does not repeat it as a field', async () => {
    const entry = await runOne((logger) =>
      logger.log({ message: 'queue drained', event: 'LIB_DRAINED', jobs: 7 })
    )

    expect(entry).toMatchObject({ msg: 'queue drained', event: 'LIB_DRAINED', jobs: 7 })
    expect(entry).not.toHaveProperty('message')
  })

  it('keeps the context a Logger without its own context is given as the last argument', async () => {
    const entry = await runOne(() => new Logger().warn({ event: 'LIB_EVENT' }, 'ExplicitContext'))

    expect(entry).toMatchObject({ context: 'ExplicitContext', msg: 'LIB_EVENT' })
  })

  it('censors a field the redaction paths name, at any depth', async () => {
    const entry = await runOne((logger) =>
      logger.warn({
        event: 'LIB_EVENT',
        password: 'hunter2-secret',
        nested: { token: 'tok-secret-value' }
      })
    )

    const text = JSON.stringify(entry)
    expect(text).not.toContain('hunter2-secret')
    expect(text).not.toContain('tok-secret-value')
    expect(entry['password']).toBe('[REDACTED]')
  })

  it('cuts a string field at maxStringLength', async () => {
    const entry = await runOne(
      (logger) => logger.warn({ event: 'LIB_EVENT', detail: 'x'.repeat(100_000) }),
      { maxStringLength: LIMIT }
    )

    expect(entry['detail']).toBe('x'.repeat(LIMIT) + '…[truncated]')
  })

  it('does not let the object overwrite the keys the entry owns', async () => {
    const entry = await runOne((logger) =>
      logger.warn({ event: 'LIB_EVENT', context: 'forged', logKey: 'FORGED', userId: 'forged' })
    )

    expect(entry).toMatchObject({ context: 'LibContext', level: 'warn' })
    expect(entry).not.toHaveProperty('logKey', 'FORGED')
    expect(entry).not.toHaveProperty('userId')
  })

  it('does not take the call down for an object whose members cannot be read', async () => {
    const hostile = {
      event: 'LIB_EVENT',
      get boom(): string {
        throw new Error('getter')
      }
    }

    const entries = await run((logger) => logger.warn(hostile))

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn' })
  })

  it('keeps an Error as the cause, as before', async () => {
    const entry = await runOne((logger) => logger.warn(new Error('boom')))

    expect(entry).toMatchObject({ level: 'warn', msg: 'boom' })
    expect(entry['err']).toBeDefined()
  })

  it('leaves a string message as it was', async () => {
    const entry = await runOne((logger) => logger.warn('[LIB_EVENT] attempts=3'))

    expect(entry).toMatchObject({ msg: '[LIB_EVENT] attempts=3' })
    expect(entry).not.toHaveProperty('attempts')
  })

  it('leaves an object that is not plain (a class instance) as it was', async () => {
    class Dto {
      readonly attempts = 3
    }

    const entry = await runOne((logger) => logger.warn(new Dto()))

    expect(entry).toMatchObject({ msg: '[object Object]' })
    expect(entry).not.toHaveProperty('attempts')
  })

  it('does not let the object replace the level, the time or the service of the entry', async () => {
    const entry = await runOne((logger) =>
      logger.warn({
        event: 'LIB_EVENT',
        level: 'fatal',
        time: 1,
        service: { name: 'forged' },
        msg: 'forged'
      })
    )

    expect(entry).toMatchObject({
      level: 'warn',
      service: { name: 'e2e-object-message', version: '0.0.0' },
      msg: 'LIB_EVENT'
    })
    expect(entry['time']).not.toBe(1)
  })

  it('drops a __proto__ key from a parsed object and does not change the entry', async () => {
    const parsed = JSON.parse('{"event":"LIB_EVENT","__proto__":{"polluted":true}}') as object

    const entry = await runOne((logger) => logger.warn(parsed))

    expect(entry).toMatchObject({ msg: 'LIB_EVENT' })
    expect(Object.hasOwn(entry, '__proto__')).toBe(false)
    expect(entry).not.toHaveProperty('polluted')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('writes an object that refers to itself without taking the call down', async () => {
    const cyclic: Record<string, unknown> = { event: 'LIB_EVENT' }
    cyclic['self'] = cyclic

    const entry = await runOne((logger) => logger.warn(cyclic))

    expect(entry).toMatchObject({ msg: 'LIB_EVENT' })
    expect(JSON.stringify(entry)).not.toContain('Maximum call stack')
  })

  it('uses no text when the object has neither a message nor an event string', async () => {
    const entry = await runOne((logger) => logger.warn({ attempts: 3, message: { not: 'text' } }))

    expect(entry).toMatchObject({ msg: '', attempts: 3, message: { not: 'text' } })
  })
})

describe('Logger E2E — metadata cannot replace the structure of the entry', () => {
  it.each(['nested', 'flat'] as const)(
    'drops level, time, msg and service from the metadata of a structured call (%s)',
    async (resourceFormat) => {
      const entry = await runOne(
        (_logger, service) =>
          service.info('LIB_EVENT', 'real text', undefined, {
            level: 'fatal',
            time: 1,
            msg: 'forged',
            service: { name: 'forged' },
            'service.name': 'forged',
            deployment: { environment: { name: 'forged' } },
            'deployment.environment.name': 'forged',
            kept: 'yes'
          }),
        {
          resourceFormat,
          service: { name: 'e2e-object-message', version: '0.0.0', environment: 'prod' }
        }
      )

      expect(entry).toMatchObject({ level: 'info', msg: 'real text', kept: 'yes' })
      expect(entry['time']).not.toBe(1)
      expect(JSON.stringify(entry)).not.toContain('forged')
      expect(JSON.stringify(entry)).toContain('prod')
    }
  )

  it.each(['nested', 'flat'] as const)(
    'drops the deployment of an object message too (%s)',
    async (resourceFormat) => {
      const entry = await runOne(
        (logger) =>
          logger.warn({
            event: 'LIB_EVENT',
            deployment: { environment: { name: 'forged' } },
            'deployment.environment.name': 'forged'
          }),
        {
          resourceFormat,
          service: { name: 'e2e-object-message', version: '0.0.0', environment: 'prod' }
        }
      )

      expect(JSON.stringify(entry)).not.toContain('forged')
      expect(JSON.stringify(entry)).toContain('prod')
    }
  )

  it('writes the event.name of an object message once when the call has no log key', async () => {
    const [raw] = await runRaw((logger) =>
      logger.warn({ event: 'LIB_EVENT', 'event.name': 'from-object' })
    )

    expect(raw?.match(/"event\.name"/g) ?? []).toHaveLength(1)
    expect(raw).toContain('"event.name":"from-object"')
  })

  it('derives event.name from the log key of a structured call and not from the metadata', async () => {
    const [raw] = await runRaw((_logger, service) =>
      service.info('LIB_EVENT', 'text', undefined, { 'event.name': 'forged' })
    )

    expect(raw?.match(/"event\.name"/g) ?? []).toHaveLength(1)
    expect(raw).toContain('"event.name":"lib.event"')
    expect(raw).not.toContain('forged')
  })

  describe('the redaction of the entry text', () => {
    /*
     * The text of an object message is a copy of one of its fields, so it is censored under the
     * same names as the field: a secret in `event` or `message` must not reach `msg`.
     */
    it.each(['event', 'message'])(
      'censors the text taken from a field named in redactPaths: %s',
      async (key) => {
        const entry = await runOne(
          (logger) => logger.warn({ [key]: 'secret-text-value', attempts: 3 }),
          {
            redactPaths: [key]
          }
        )

        expect(JSON.stringify(entry)).not.toContain('secret-text-value')
        expect(entry).toMatchObject({ attempts: 3 })
      }
    )

    it('censors the text under redactStrategy paths too', async () => {
      const entry = await runOne((logger) => logger.warn({ event: 'secret-text-value' }), {
        redactStrategy: 'paths',
        redactPaths: ['event']
      })

      expect(JSON.stringify(entry)).not.toContain('secret-text-value')
    })

    it('leaves the text alone when its field is not redacted', async () => {
      const entry = await runOne((logger) => logger.warn({ event: 'LIB_EVENT' }), {
        redactPaths: ['password']
      })

      expect(entry).toMatchObject({ msg: 'LIB_EVENT' })
    })
  })

  describe('an object that is shaped like an error', () => {
    it('is written as an error only, without its fields at the root', async () => {
      const entry = await runOne(
        (logger) =>
          logger.warn({ name: 'DriverError', message: 'failed', stdout: 'private-output' }),
        { errorOwnFields: 'safe' }
      )

      expect(entry['err']).toBeDefined()
      expect(entry).not.toHaveProperty('stdout')
      expect(JSON.stringify(entry)).not.toContain('private-output')
    })
  })
})
