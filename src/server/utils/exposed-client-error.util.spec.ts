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
    expect(readExposedClientError(value)).toEqual({ status, message: 'm' })
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
      'unsupported content encoding'
    ],
    ['charset.unsupported', 'unsupported charset "CLIENT"', 'unsupported charset'],
    ['entity.too.large', 'request entity too large', 'request entity too large'],
    ['something.else', 'a message of its own', 'a message of its own']
  ])('words an error of type %s as %j', (type, thrown, sent) => {
    const error = { status: 415, expose: true, type, message: thrown }

    expect(readExposedClientError(error)).toEqual({ status: 415, message: sent })
  })

  it('keeps the message of an error with no type, or a type that is not text', () => {
    expect(readExposedClientError({ status: 415, expose: true, message: 'm' })?.message).toBe('m')
    expect(
      readExposedClientError({ status: 415, expose: true, type: 7, message: 'm' })?.message
    ).toBe('m')
  })
})
