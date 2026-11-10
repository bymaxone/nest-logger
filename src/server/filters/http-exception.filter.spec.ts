/**
 * Pins `HttpExceptionFilter`: what it logs and what it answers for each kind of thrown value. A
 * 4xx `HttpException` is logged as handled at warn level and answered with its own status and body;
 * a 5xx one and any other thrown value are logged as unhandled at error level, the first answered
 * with the exception's own body and the second with the fixed 500 body; the acting user comes from
 * `req.user`, the JWT subject over the ORM id; and the logged `url` carries no query string.
 *
 * Layer: server/filters, tests. The filter is called directly with a logger double and host,
 * request and response doubles; the same behaviour through a running Nest application is pinned by
 * the end-to-end cases in `test/e2e`.
 */
import { BadRequestException, InternalServerErrorException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'

import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

interface Outcome {
  readonly warn: jest.Mock
  readonly error: jest.Mock
  readonly status: jest.Mock
  readonly json: jest.Mock
}

/** Runs the filter on `exception` for `request` and returns what it logged and wrote. */
function run(exception: unknown, request: Partial<LoggableRequest> = {}): Outcome {
  const warn = jest.fn()
  const error = jest.fn()
  const logger = { warnStructured: warn, errorStructured: error } as unknown as PinoLoggerService
  const json = jest.fn()
  const status = jest.fn()
  const res = { status, json } as unknown as LoggableResponse
  status.mockReturnValue(res)
  const req = { method: 'GET', url: '/path', headers: {}, ...request } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost

  new HttpExceptionFilter(logger).catch(exception, host)

  return { warn, error, status, json }
}

describe('HttpExceptionFilter', () => {
  it(/*
   * A 4xx HttpException must log HTTP_EXCEPTION_HANDLED at warn level and the response must echo
   * the exception's own status and body.
   */
  'logs HTTP_EXCEPTION_HANDLED (warn) and renders a 4xx', () => {
    const { warn, error, status, json } = run(new BadRequestException('bad input'))

    expect(status).toHaveBeenCalledWith(400)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'bad input' })
    )
    expect(warn).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_HANDLED',
      'bad input',
      undefined,
      expect.objectContaining({ status: 400, method: 'GET' })
    )
    expect(error).not.toHaveBeenCalled()
  })

  it(/*
   * A 5xx HttpException must log HTTP_EXCEPTION_UNHANDLED at error level, with a sanitized error,
   * and render the exception's own status and body, not the generic internal-error body.
   */
  'logs HTTP_EXCEPTION_UNHANDLED (error) for a 5xx HttpException and renders its own body', () => {
    const { warn, error, status, json } = run(new InternalServerErrorException('explicit 500'))

    expect(error).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String), message: expect.any(String) }),
      undefined,
      expect.objectContaining({ status: 500 })
    )
    expect(warn).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'explicit 500' })
    )
  })

  it(/*
   * A non-HttpException must be treated as an unhandled 500: logged as HTTP_EXCEPTION_UNHANDLED and
   * rendered with the generic internal-error body, which does not carry its message.
   */
  'treats a generic Error as an unhandled 500', () => {
    const { warn, error, status, json } = run(new Error('kaboom'))

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' })
    expect(error).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      undefined,
      expect.objectContaining({ status: 500 })
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['req.user.id when it is the only field', { id: 'u_1' }, 'u_1'],
    ['req.user.sub when id is absent (a JWT principal)', { sub: 's_1' }, 's_1'],
    ['req.user.sub over req.user.id when both are present', { sub: 's_2', id: 'u_2' }, 's_2']
  ])('attaches the acting user from %s', (_name, user, expected) => {
    // `sub ?? id`: an `id ?? sub` swap would attribute the error to the ORM id.
    const { error } = run(new Error('user boom'), { user })

    expect(error).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      expected,
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * The logged `url` must have its query string stripped: query params routinely carry secrets
   * (reset tokens, OAuth codes) and cannot be redacted as a substring once embedded in the URL.
   */
  'strips the query string from the logged url', () => {
    const { error } = run(new Error('kaboom'), { url: '/boom?token=supersecret&x=1' })

    const metadata = error.mock.calls.at(-1)?.[3] as Record<string, unknown>
    expect(metadata).toMatchObject({ url: '/boom' })
    expect(JSON.stringify(metadata)).not.toContain('supersecret')
  })
})
