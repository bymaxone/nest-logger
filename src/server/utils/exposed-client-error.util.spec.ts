/**
 * Pins `readExposedClientError`: the `http-errors` shape is read only when it says the message is
 * safe to expose and the status is a client error, and a hostile object never makes it throw.
 *
 * Layer: server, utils, tests.
 */
import { readExposedClientError } from './exposed-client-error.util'

describe('readExposedClientError', () => {
  it.each([
    ['status', { status: 413, expose: true, message: 'm' }, 413],
    ['statusCode', { statusCode: 415, expose: true, message: 'm' }, 415],
    ['the lowest client status', { status: 400, expose: true, message: 'm' }, 400],
    ['the highest client status', { status: 499, expose: true, message: 'm' }, 499],
    ['status before statusCode', { status: 404, statusCode: 413, expose: true, message: 'm' }, 404]
  ])('reads %s', (_name, value, status) => {
    expect(readExposedClientError(value)).toEqual({ status, message: 'm', logMessage: 'm' })
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 413],
    ['undefined', undefined],
    ['no expose', { status: 413, message: 'm' }],
    ['expose false', { status: 413, expose: false, message: 'm' }],
    ['expose as text', { status: 413, expose: 'true', message: 'm' }],
    ['a status below 400', { status: 399, expose: true, message: 'm' }],
    ['a status of 500', { status: 500, expose: true, message: 'm' }],
    ['a fractional status', { status: 413.5, expose: true, message: 'm' }],
    ['a status as text', { status: '413', expose: true, message: 'm' }],
    ['no status', { expose: true, message: 'm' }],
    ['no message', { status: 413, expose: true }],
    ['a message that is not text', { status: 413, expose: true, message: 7 }]
  ])('reads nothing from %s', (_name, value) => {
    expect(readExposedClientError(value)).toBeUndefined()
  })

  it('reads nothing, without throwing, from an object whose getter throws', () => {
    const hostile = {
      expose: true,
      message: 'm',
      get status(): number {
        throw new Error('boom')
      }
    }

    expect(readExposedClientError(hostile)).toBeUndefined()
  })

  it('reads nothing, without throwing, from a Proxy whose get trap throws', () => {
    const proxy = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap')
        }
      }
    )

    expect(readExposedClientError(proxy)).toBeUndefined()
  })

  it.each([
    [
      'encoding.unsupported',
      'unsupported content encoding "x-CLIENT"',
      'unsupported content encoding',
      'unsupported content encoding'
    ],
    [
      'charset.unsupported',
      'unsupported charset "CLIENT"',
      'unsupported charset',
      'unsupported charset'
    ],
    [
      'entity.parse.failed',
      `Unexpected token 'h', "hunter2" is not valid JSON`,
      `Unexpected token 'h', "hunter2" is not valid JSON`,
      'request body could not be parsed'
    ],
    [
      'entity.verify.failed',
      'verify says hunter2',
      'verify says hunter2',
      'request body verification failed'
    ]
  ])('words an error of type %s for the client and for the log', (type, thrown, sent, logged) => {
    const error = { status: 415, expose: true, type, message: thrown }

    expect(readExposedClientError(error)).toEqual({
      status: 415,
      message: sent,
      logMessage: logged,
      bodyParserType: type
    })
  })

  it.each([
    ['entity.too.large', 'request entity too large'],
    ['request.aborted', 'request aborted'],
    ['something.else', 'a message of its own']
  ])(
    'passes the message of an error of type %s through, to the client and to the log',
    (type, m) => {
      const error = { status: 413, expose: true, type, message: m }

      expect(readExposedClientError(error)).toEqual({ status: 413, message: m, logMessage: m })
    }
  )

  it('keeps the message of an error with no type, or a type that is not text', () => {
    expect(readExposedClientError({ status: 415, expose: true, message: 'm' })?.message).toBe('m')
    expect(
      readExposedClientError({ status: 415, expose: true, type: 7, message: 'm' })?.message
    ).toBe('m')
  })
})
