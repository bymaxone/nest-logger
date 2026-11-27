/**
 * Unit tests for the redaction of the objects that reach the message.
 *
 * Layer: server/utils. The Pino instances are real and write to an array.
 */
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

import {
  guardMessageValues,
  messageSerializers,
  redactMessageOutput
} from './guard-message-values.util'
import type { Redactor } from './redact-by-name.util'

const mark: Redactor = (value) => ({ walked: value })

/** A real Pino instance with the message serializer, and the messages it writes. */
function build(redact: Redactor = mark): { logger: PinoLogger; messages: () => unknown[] } {
  const written: string[] = []
  const logger = pino(
    { base: null, timestamp: false, serializers: messageSerializers('names', redact, redact) },
    { write: (line: string) => void written.push(line) }
  )
  return {
    logger,
    messages: () => written.map((line) => (JSON.parse(line) as { msg?: unknown }).msg)
  }
}

/** The logger with the arguments Pino accepts at run time. */
const log = (logger: PinoLogger, ...inputs: unknown[]): void => {
  Reflect.apply(logger.info, logger, inputs)
}

describe('messageSerializers', () => {
  it('walks an object message, and the message Pino takes from err.message', () => {
    const { logger, messages } = build()

    log(logger, {}, { a: 1 })
    log(logger, { err: { message: { b: 2 } } })
    log(logger.child({}), {}, { c: 3 })

    expect(messages()).toStrictEqual([
      { walked: { a: 1 } },
      { walked: { b: 2 } },
      { walked: { c: 3 } }
    ])
  })

  it('walks a function, which can carry a toJSON', () => {
    const { logger, messages } = build(() => 'walked')
    const fn = Object.assign(() => 0, { toJSON: () => 'own' })

    log(logger, {}, fn)

    expect(messages()).toStrictEqual(['walked'])
  })

  it('tells the redactor that the value goes into the message', () => {
    const redact = jest.fn(mark)
    const { logger } = build(redact)
    guardMessageValues(logger, redact, 'names')

    log(logger, '%o', { a: 1 })
    log(logger, {}, { b: 2 })

    expect(redact.mock.calls).toStrictEqual([
      [{ a: 1 }, false, true],
      [{ b: 2 }, false, true]
    ])
  })

  it('writes no msg for a message the walk leaves nothing of', () => {
    const { logger, messages } = build(() => undefined)

    log(logger, {}, { a: 1 })

    expect(messages()).toStrictEqual([undefined])
  })

  it('leaves primitives as they are', () => {
    const redact = jest.fn(mark)
    const { logger, messages } = build(redact)
    guardMessageValues(logger, redact, 'names')

    log(logger, '%o %o %s', 5, null, 'x')
    log(logger, {}, 'plain')
    log(logger, {}, null)

    expect(messages()).toStrictEqual(['5 null x', 'plain', null])
    expect(redact).not.toHaveBeenCalled()
  })

  it("walks under 'paths' only what holds a binary value, with the redactor of the record", () => {
    const record = jest.fn((value: unknown) => ({ walked: value }))
    const { msg } = messageSerializers('paths', mark, record)
    const plain = { a: 1 }
    const binary = { a: Buffer.from('x') }

    expect(msg(plain)).toBe(plain)
    expect(msg(binary)).toStrictEqual({ walked: binary })
    expect(record.mock.calls).toStrictEqual([[binary, false, true]])
  })
})

describe('guardMessageValues', () => {
  it('walks the value of a placeholder, of a child too', () => {
    const { logger, messages } = build()
    guardMessageValues(logger, mark, 'names')

    log(logger, '%o', { a: 1 })
    log(logger.child({}), '%o', { a: 1 })

    expect(messages()).toStrictEqual(['{"walked":{"a":1}}', '{"walked":{"a":1}}'])
  })

  it('guards a child only when Pino gave it format options of its own', () => {
    const { logger, messages } = build()
    const guardChild = guardMessageValues(logger, mark, 'names')
    const own = logger.child({}, { redact: ['nothing'] })
    const inherited = logger.child({})

    log(own, '%o', { a: 1 })
    guardChild(own)
    guardChild(inherited)
    log(own, '%o', { a: 1 })
    log(inherited, '%o', { a: 1 })

    expect(messages()).toStrictEqual(['{"a":1}', '{"walked":{"a":1}}', '{"walked":{"a":1}}'])
    expect(Object.getOwnPropertySymbols(inherited)).not.toContain(pino.symbols.formatOptsSym)
  })

  it('leaves the format options writable, so Pino can replace them on a child', () => {
    const { logger } = build()

    guardMessageValues(logger, mark, 'names')

    expect(Object.getOwnPropertyDescriptor(logger, pino.symbols.formatOptsSym)).toMatchObject({
      writable: true,
      configurable: true
    })
  })

  it.each([
    ['no symbols', undefined],
    ['no formatOptsSym', { writeSym: pino.symbols.writeSym }],
    ['a formatOptsSym the logger lacks', { ...pino.symbols, formatOptsSym: Symbol('other') }]
  ])('refuses a Pino with %s', (_name, symbols) => {
    const { logger } = build()
    jest.replaceProperty(pino, 'symbols', symbols as typeof pino.symbols)

    expect(() => guardMessageValues(logger, mark, 'names')).toThrow('LOGGER_PINO_UNSUPPORTED')
  })

  it('refuses format options without a stringify function', () => {
    const { logger } = build()
    Reflect.set(logger, pino.symbols.formatOptsSym, {})

    expect(() => guardMessageValues(logger, mark, 'names')).toThrow('LOGGER_PINO_UNSUPPORTED')
  })
})

describe('redactMessageOutput', () => {
  it("tells the redactor under 'names' that the output goes into the message", () => {
    const redact = jest.fn(() => 'walked')

    expect(redactMessageOutput('names', redact)('text')).toBe('walked')
    expect(redact).toHaveBeenCalledWith('text', false, true)
  })

  it("writes no msg under 'names' for an output the walk leaves nothing of", () => {
    const written = redactMessageOutput('names', () => undefined)('text')

    expect(typeof written).toBe('function')
  })

  it("redacts under 'paths' as any other serializer output", () => {
    const redact = jest.fn(() => undefined)

    expect(redactMessageOutput('paths', redact)('text')).toBeUndefined()
    expect(redact).toHaveBeenCalledWith('text')
  })
})
