/**
 * Pins the error layer that keeps a body-parser error's type for the exception filter: it records
 * only an error the library words with a fixed text, and it passes every error on untouched, even
 * when the request cannot hold the record.
 *
 * Layer: server, middlewares, tests.
 */
import { readRecordedParserError } from '../utils/http-log-state.util'

import { recordParserErrorMiddleware } from './record-parser-error.middleware'

const parseError = (): Error =>
  Object.assign(new SyntaxError('Unexpected token'), {
    status: 400,
    expose: true,
    type: 'entity.parse.failed'
  })

describe('recordParserErrorMiddleware', () => {
  it('records the error of a body that did not parse, and passes it on untouched', () => {
    const req = {}
    const error = parseError()
    const next = jest.fn()

    recordParserErrorMiddleware(error, req, {}, next)

    expect(readRecordedParserError(req)).toEqual({
      status: 400,
      message: 'Unexpected token',
      logMessage: 'request body could not be parsed',
      bodyParserType: 'entity.parse.failed'
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(error)
  })

  it.each([
    [
      'an exposed error of a type with a message of its own',
      { status: 413, expose: true, type: 'entity.too.large', message: 'm' }
    ],
    ['an error that is not exposed', Object.assign(new Error('m'), { status: 500 })],
    ['a value that is not an error', 'boom']
  ])('records nothing for %s, and passes it on', (_name, error) => {
    const req = {}
    const next = jest.fn()

    recordParserErrorMiddleware(error, req, {}, next)

    expect(readRecordedParserError(req)).toBeUndefined()
    expect(next).toHaveBeenCalledWith(error)
  })

  it('passes the error on once when the request cannot hold the record', () => {
    const req = new Proxy(
      {},
      {
        set: () => {
          throw new Error('set trap')
        }
      }
    )
    const error = parseError()
    const next = jest.fn()

    expect(() => recordParserErrorMiddleware(error, req, {}, next)).not.toThrow()

    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(error)
  })
})
