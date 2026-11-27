/**
 * Verifies that the guard redacts what `child()` and `setBindings()` receive, composes its redaction
 * after the formatters and serializers of the child options, and leaves the rest of the options as
 * the caller wrote them.
 *
 * Layer: server/utils, tests.
 */
import pino from 'pino'
import type { ChildLoggerOptions, Logger as PinoLogger } from 'pino'

import { guardChildBindings } from './guard-child-bindings.util'

/** A redactor that marks what it was given, so a test can see where it ran. */
const mark =
  (name: string) =>
  (value: unknown): unknown =>
    typeof value === 'object' && value !== null
      ? { ...value, [name]: true }
      : `${name}:${String(value)}`

/** A guarded Pino instance with markers for redactors, and the records it writes. */
function build(): { logger: PinoLogger; lines: () => Array<Record<string, unknown>> } {
  const written: string[] = []
  const logger = guardChildBindings(
    pino({ base: null, timestamp: false }, { write: (line: string) => void written.push(line) }),
    {
      redactBindings: mark('boundMark'),
      redactSerialized: mark('serializedMark'),
      formatRecord: (record) => ({ ...record, recordMark: true })
    }
  )
  return {
    logger,
    lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

/** The one line a child built with `options` writes. */
function childLine(
  bindings: Record<string, unknown>,
  options?: ChildLoggerOptions,
  record: Record<string, unknown> = {}
): Record<string, unknown> {
  const { logger, lines } = build()
  logger.child(bindings, options).info(record, 'm')
  return lines()[0] as Record<string, unknown>
}

describe('guardChildBindings', () => {
  it('redacts bindings, with and without options, at every depth', () => {
    const { logger, lines } = build()

    logger.child({ a: 1 }).info('m')
    logger.child({ a: 1 }, { level: 'debug' }).debug('m')
    logger.child({}).child({ b: 2 }).info('m')

    expect(lines()).toMatchObject([
      { a: 1, boundMark: true },
      { a: 1, boundMark: true, level: 20 },
      { b: 2, boundMark: true }
    ])
  })

  it('redacts what setBindings adds, on the instance and on a child', () => {
    const { logger, lines } = build()
    const child = logger.child({})

    logger.setBindings({ a: 1 })
    child.setBindings({ b: 2 })
    logger.info('m')
    child.info('m')

    expect(lines()).toMatchObject([
      { a: 1, boundMark: true },
      { b: 2, boundMark: true }
    ])
  })

  it('leaves missing bindings to Pino', () => {
    const { logger } = build()

    expect(() => logger.child(undefined as never)).toThrow('missing bindings for child Pino')
    expect(() => logger.child(null as never)).toThrow('missing bindings for child Pino')
  })

  it('runs the redaction after the formatters of the child options', () => {
    const line = childLine(
      { a: 1 },
      {
        formatters: {
          bindings: (b) => ({ ...b, hostBound: b['boundMark'] }),
          log: (o) => ({ ...o, hostLogged: !('recordMark' in o) })
        }
      }
    )

    expect(line).toMatchObject({
      hostBound: true,
      boundMark: true,
      hostLogged: true,
      recordMark: true
    })
  })

  it('keeps the formatters the child options do not bring', () => {
    const onlyLog = childLine({ a: 1 }, { formatters: { log: (o) => ({ ...o, own: true }) } })
    const onlyBindings = childLine({ a: 1 }, { formatters: { bindings: (b) => b } })

    expect(onlyLog).toMatchObject({ a: 1, boundMark: true, own: true, recordMark: true })
    expect(onlyBindings).toMatchObject({ a: 1, boundMark: true })
    expect(onlyBindings).not.toHaveProperty('recordMark')
  })

  it('redacts what a level formatter of the child options returns, passing it both arguments', () => {
    const line = childLine(
      {},
      {
        customLevels: { audit: 35 },
        formatters: { level: (label, value) => ({ level: label, value }) }
      }
    )

    expect(line).toMatchObject({ level: 'info', value: 30, serializedMark: true })
  })

  it('redacts what a serializer of the child options returns, keeping its this', () => {
    const serializers = {
      account: function (this: unknown, id: unknown): unknown {
        return { id, bound: this !== undefined }
      }
    }

    const line = childLine({}, { serializers }, { account: 'a1' })

    expect(line['account']).toEqual({ id: 'a1', bound: true, serializedMark: true })
  })

  it('guards the serializers Pino reads by inheritance', () => {
    const serializers = Object.create({
      inherited: (v: unknown) => `i:${String(v)}`
    }) as NonNullable<ChildLoggerOptions['serializers']>

    const line = childLine({}, { serializers }, { inherited: 'v' })

    expect(line['inherited']).toBe('serializedMark:i:v')
  })

  it('leaves a serializer entry that is not a function as it was', () => {
    const line = childLine({}, { serializers: { account: undefined as never } }, { account: 'a1' })

    expect(line['account']).toBe('a1')
  })

  it('reads members the options inherit, and copies a frozen object', () => {
    class Options {
      get level(): string {
        return 'debug'
      }
    }
    class Formatters {
      bindings(b: Record<string, unknown>): Record<string, unknown> {
        return { ...b, hostBound: true }
      }
      log(o: Record<string, unknown>): Record<string, unknown> {
        return { ...o, hostLogged: true }
      }
    }
    const options = Object.freeze(
      Object.assign(new Options(), { formatters: Object.freeze(new Formatters()) })
    ) as unknown as ChildLoggerOptions
    const { logger, lines } = build()

    logger.child({}, options).debug('m')

    expect(lines()[0]).toMatchObject({
      hostBound: true,
      boundMark: true,
      hostLogged: true,
      recordMark: true,
      level: 20
    })
  })

  it('ignores formatters and serializers the options only inherit, as Pino does', () => {
    const options = Object.create({
      formatters: { log: () => ({ inheritedLog: true }) },
      serializers: { account: () => 'inherited' }
    }) as ChildLoggerOptions

    const line = childLine({}, options, { account: 'a1' })

    expect(line['account']).toBe('a1')
    expect(line).not.toHaveProperty('inheritedLog')
  })

  it('passes options that are not an object through to Pino', () => {
    expect(childLine({ a: 1 }, null as never)).toMatchObject({ a: 1, boundMark: true })
    expect(childLine({ a: 1 }, 5 as never)).toMatchObject({ a: 1, boundMark: true })
  })

  it('answers as Pino does for formatters or serializers that are set to nothing', () => {
    const { logger } = build()

    expect(() => logger.child({}, { formatters: undefined } as never)).toThrow(TypeError)
    expect(() => logger.child({}, { serializers: undefined } as never)).toThrow(TypeError)
  })
})
