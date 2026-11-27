/**
 * Unit tests for the redaction of the objects that reach the message.
 *
 * Layer: server/utils. The Pino instances are real and write to an array.
 */
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

import { guardMessageValues } from './guard-message-values.util'
import type { Redactor } from './redact-by-name.util'

const mark: Redactor = (value) => ({ walked: value })

/** A real Pino instance, and the messages it writes. */
function build(): { logger: PinoLogger; messages: () => unknown[] } {
  const written: string[] = []
  const logger = pino(
    { base: null, timestamp: false },
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

describe('guardMessageValues', () => {
  it('walks the value of a placeholder and an object message', () => {
    const { logger, messages } = build()
    guardMessageValues(logger, mark)

    log(logger, '%o', { a: 1 })
    log(logger, {}, { a: 1 })
    log(logger.child({}), '%o', { a: 1 })

    expect(messages()).toStrictEqual([
      '{"walked":{"a":1}}',
      { walked: { a: 1 } },
      '{"walked":{"a":1}}'
    ])
  })

  it('walks a function, which can carry a toJSON', () => {
    const { logger, messages } = build()
    guardMessageValues(logger, () => 'walked')
    const fn = Object.assign(() => 0, { toJSON: () => 'own' })

    log(logger, fn as unknown, '%o')

    expect(messages()).toHaveLength(1)
    expect(JSON.stringify(messages())).not.toContain('own')
  })

  it('leaves primitives as they are', () => {
    const { logger, messages } = build()
    const redact = jest.fn(mark)
    guardMessageValues(logger, redact)

    log(logger, '%o %o %s', 5, null, 'x')
    log(logger, {}, 'plain')

    expect(messages()).toStrictEqual(['5 null x', 'plain'])
    expect(redact).not.toHaveBeenCalled()
  })

  it('guards a child only when Pino gave it format options of its own', () => {
    const { logger, messages } = build()
    const guardChild = guardMessageValues(logger, mark)
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

  it.each([
    ['no symbols', undefined],
    ['no formatOptsSym', { writeSym: pino.symbols.writeSym }],
    ['no writeSym', { formatOptsSym: pino.symbols.formatOptsSym }],
    ['a writeSym the logger lacks', { ...pino.symbols, writeSym: Symbol('other') }],
    ['a formatOptsSym the logger lacks', { ...pino.symbols, formatOptsSym: Symbol('other') }]
  ])('refuses a Pino with %s', (_name, symbols) => {
    const { logger } = build()
    jest.replaceProperty(pino, 'symbols', symbols as typeof pino.symbols)

    expect(() => guardMessageValues(logger, mark)).toThrow('LOGGER_PINO_UNSUPPORTED')
  })

  it('refuses format options without a stringify function', () => {
    const { logger } = build()
    Reflect.set(logger, pino.symbols.formatOptsSym, {})

    expect(() => guardMessageValues(logger, mark)).toThrow('LOGGER_PINO_UNSUPPORTED')
  })
})
