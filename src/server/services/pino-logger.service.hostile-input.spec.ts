/**
 * Pins that the NestJS variadic methods never throw because of what the caller handed them: an
 * `Error` whose `name` or `message` cannot be read, or a message with no text form. Driven through
 * the real Pino pipeline, so the assertions are on the entry that reaches a destination.
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

/** A logger over the real factory whose destination captures each entry, parsed. */
function createPipeline(): {
  service: PinoLoggerService
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

const throwing = (label: string): never => {
  throw new Error(label)
}

/** An `Error` that throws when the named property is read. */
const unreadable = (property: 'name' | 'message'): Error =>
  Object.defineProperty(new Error('boom'), property, {
    get: () => throwing(`${property} exploded`)
  })

type Call = (service: PinoLoggerService, value: unknown) => void

/** Every variadic position an `Error` can arrive in, leading or trailing, at each level. */
const errorPositions: [string, Call][] = [
  ['error(err)', (s, e) => s.error(e)],
  ["error('msg', err)", (s, e) => s.error('msg', e)],
  ["error('msg', stack, ctx, err)", (s, e) => s.error('msg', 'stack', 'ctx', e)],
  ["warn('msg', err)", (s, e) => s.warn('msg', e)],
  ['warn(err)', (s, e) => s.warn(e)],
  ["log('msg', err)", (s, e) => s.log('msg', e)],
  ['fatal(err)', (s, e) => s.fatal(e)]
]

describe('the variadic methods with an Error that cannot be read', () => {
  describe.each(['name', 'message'] as const)('with a throwing %s getter', (property) => {
    it.each(errorPositions)('%s does not throw and still logs the error', (_label, call) => {
      /*
       * `catch (e) { logger.error(e) }` is the call site: a second throw out of the logging
       * call replaces the first error with one about the logger. The call must return, and the
       * entry must carry the error as the same marked node errorStructured produces.
       */
      const { service, entries } = createPipeline()

      expect(() => call(service, unreadable(property))).not.toThrow()

      expect(entries()).toHaveLength(1)
      expect(entries()[0]?.['err']).toMatchObject({ type: 'SanitizeFailed' })
    })
  })
})

describe('the variadic methods with a message that has no text form', () => {
  /*
   * A plain object is the fields of the entry and has no text to read, so it is not a shape here.
   * What has no text form is a value that is not plain: an instance whose toString throws, and an
   * object whose prototype chain ends in a null prototype.
   */
  const shapes: [string, () => unknown][] = [
    [
      'an object whose prototype has no toString',
      () => Object.create(Object.create(null)) as unknown
    ],
    [
      'an instance whose toString throws',
      () =>
        new (class {
          toString(): string {
            return throwing('toString exploded')
          }
        })()
    ]
  ]
  const methods: [string, (s: PinoLoggerService, v: unknown) => void][] = [
    ['error', (s, v) => s.error(v)],
    ['warn', (s, v) => s.warn(v)],
    ['log', (s, v) => s.log(v)]
  ]

  describe.each(shapes)('with %s', (_shape, make) => {
    it.each(methods)('%s does not throw and still emits an entry', (_method, call) => {
      /*
       * A message is read to build the log line, and a caller value that cannot be turned into
       * text must not take the call down: the entry is emitted with a fixed stand-in line.
       */
      const { service, entries } = createPipeline()

      expect(() => call(service, make())).not.toThrow()

      expect(entries()).toHaveLength(1)
      expect(entries()[0]).toMatchObject({ msg: 'Unreadable log message' })
    })
  })

  describe.each([
    ['a null-prototype object', () => Object.create(null) as unknown],
    [
      'an object whose toString throws',
      () => ({
        toString(): string {
          return throwing('toString exploded')
        }
      })
    ]
  ] as [string, () => unknown][])('with %s, which is plain', (_shape, make) => {
    it.each(methods)('%s emits an entry with no text and does not throw', (_m, call) => {
      const { service, entries } = createPipeline()

      expect(() => call(service, make())).not.toThrow()

      expect(entries()).toHaveLength(1)
      expect(entries()[0]).toMatchObject({ msg: '' })
    })
  })
})

describe('the variadic methods with a readable error (control)', () => {
  it.each(errorPositions)('%s keeps logging the error as before', (_label, call) => {
    const { service, entries } = createPipeline()

    call(service, new TypeError('boom'))

    expect(entries()[0]?.['err']).toMatchObject({ type: 'TypeError', message: 'boom' })
  })
})

describe('the variadic methods with an object message whose members throw', () => {
  /*
   * The entry text is read from `message`, then from `event`; a member that throws on read is
   * absent, so the next candidate stands and the call is not taken down.
   */
  it.each([
    ['error', (s: PinoLoggerService, v: unknown) => s.error(v)],
    ['warn', (s: PinoLoggerService, v: unknown) => s.warn(v)]
  ])('%s reads the event when the message throws', (_method, call) => {
    const { service, entries } = createPipeline()
    const hostile = {
      get message(): string {
        return throwing('message exploded')
      },
      event: 'LIB_EVENT'
    }

    expect(() => call(service, hostile)).not.toThrow()

    expect(entries()).toHaveLength(1)
    expect(entries()[0]).toMatchObject({ msg: 'LIB_EVENT' })
  })

  it('uses no text when both members throw', () => {
    const { service, entries } = createPipeline()
    const hostile = {
      get message(): string {
        return throwing('message exploded')
      },
      get event(): string {
        return throwing('event exploded')
      }
    }

    expect(() => service.warn(hostile)).not.toThrow()

    expect(entries()[0]).toMatchObject({ msg: '' })
  })

  it('keeps a message that is a string as the text and drops it from the fields', () => {
    const { service, entries } = createPipeline()

    service.warn({ message: 'text', event: 'LIB_EVENT', attempts: 3 })

    expect(entries()[0]).toMatchObject({ msg: 'text', event: 'LIB_EVENT', attempts: 3 })
    expect(entries()[0]).not.toHaveProperty('message')
  })
})
