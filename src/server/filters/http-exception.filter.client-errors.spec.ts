/**
 * Pins how `HttpExceptionFilter` answers an error that is not an `HttpException` but carries an
 * `http-errors` shape (`status` or `statusCode` in 400-499 and `expose: true`), which is what the
 * body parser raises for a body over the limit (413) or an unsupported content encoding (415). The
 * client error keeps its status; every other non-`HttpException` stays a 500.
 *
 * Layer: server/filters, tests. The filter is called directly with a logger double and host,
 * request and response doubles; what the real body parser raises, through a running Nest
 * application, is pinned in `test/e2e/client-error-from-parser.e2e-spec.ts`.
 */
import type { ArgumentsHost } from '@nestjs/common'

import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

/** An error shaped like the ones the `http-errors` package builds. */
function httpError(fields: Record<string, unknown>, message = 'refused'): Error {
  return Object.assign(new Error(message), fields)
}

/** Runs the filter on `exception` and returns what it logged and wrote. */
function run(exception: unknown): {
  warn: jest.Mock
  error: jest.Mock
  status: jest.Mock
  json: jest.Mock
} {
  const warn = jest.fn()
  const error = jest.fn()
  const logger = { warnStructured: warn, errorStructured: error } as unknown as PinoLoggerService
  const json = jest.fn()
  const status = jest.fn()
  const res = { status, json } as unknown as LoggableResponse
  status.mockReturnValue(res)
  const req = { method: 'GET', url: '/shape', headers: {} } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost

  new HttpExceptionFilter(logger).catch(exception, host)

  return { warn, error, status, json }
}

describe('HttpExceptionFilter, a client error that is not an HttpException', () => {
  it.each([
    ['status', httpError({ status: 413, expose: true }, 'request entity too large'), 413],
    [
      'status-code',
      httpError({ statusCode: 415, expose: true }, 'unsupported content encoding'),
      415
    ],
    ['bad-request', httpError({ status: 400, expose: true }, 'bad request'), 400]
  ])('keeps the %s of an exposed client error', (_name, exception, code) => {
    const { warn, error, status, json } = run(exception)

    expect(status).toHaveBeenCalledWith(code)
    expect(json).toHaveBeenCalledWith({ statusCode: code, message: exception.message })
    expect(warn).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_HANDLED',
      exception.message,
      undefined,
      expect.objectContaining({ status: code, method: 'GET' })
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('logs the fixed text, not the message, for an exposed error of a type that quotes the body', () => {
    const exception = httpError(
      { status: 400, expose: true, type: 'entity.parse.failed' },
      `Unexpected token 'h', "hunter2-SENTINEL" is not valid JSON`
    )

    const { warn, json } = run(exception)

    expect(json).toHaveBeenCalledWith({ statusCode: 400, message: exception.message })
    expect(warn).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_HANDLED',
      'request body could not be parsed',
      undefined,
      expect.objectContaining({ bodyParserType: 'entity.parse.failed' })
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2')
  })

  it.each([
    ['hidden', httpError({ status: 413, expose: false }, 'internal detail')],
    ['server', httpError({ status: 503, expose: true }, 'unavailable')],
    ['low', httpError({ status: 399, expose: true })],
    ['high', httpError({ status: 600, expose: true })],
    ['fraction', httpError({ status: 413.5, expose: true })],
    ['text', httpError({ status: '413', expose: true })],
    ['no-expose', httpError({ status: 413 })]
  ])('stays an unhandled 500 for the %s shape', (_name, exception) => {
    const { error, status, json } = run(exception)

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' })
    expect(error).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.anything(),
      undefined,
      expect.objectContaining({ status: 500 })
    )
  })

  it.each([
    ['a content encoding', 'unsupported content encoding', 'encoding.unsupported'],
    ['a charset', 'unsupported charset', 'charset.unsupported']
  ])(
    'echoes nothing of the client when it names %s the parser does not support',
    (_name, message, type) => {
      const exception = httpError(
        { status: 415, expose: true, type },
        `${message} "x-CLIENT-MARKER"`
      )

      const { warn, json } = run(exception)

      expect(json).toHaveBeenCalledWith({ statusCode: 415, message })
      expect(warn).toHaveBeenCalledWith(
        'HTTP_EXCEPTION_HANDLED',
        message,
        undefined,
        expect.objectContaining({ status: 415 })
      )
      expect(JSON.stringify([json.mock.calls, warn.mock.calls])).not.toMatch(/marker/i)
    }
  )
})
