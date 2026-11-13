/**
 * Pins what `HttpExceptionFilter` writes for a request whose path carries a credential: the logged
 * `url` and the not-found message hold `:redacted` in its place, for the built-in patterns and for
 * the host's own `http.secretPathSegments`. A filter built with the logger alone keeps the built-in
 * patterns.
 *
 * Layer: server/filters, tests, with a logger double and host, request and response doubles.
 */
import { NotFoundException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'

import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import type { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

const HEX = 'a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a'

/** The one logged warning for `url`, with the filter built from `secretPathSegments` or alone. */
function warned(
  url: string,
  secretPathSegments?: readonly RegExp[]
): { readonly message: string; readonly url: string } {
  const warn = jest.fn()
  const logger = {
    warnStructured: warn,
    errorStructured: jest.fn()
  } as unknown as PinoLoggerService
  const status = jest.fn()
  const res = { status, json: jest.fn() } as unknown as LoggableResponse
  status.mockReturnValue(res)
  const req = { method: 'GET', url, originalUrl: url, headers: {} } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost
  const options =
    secretPathSegments === undefined
      ? undefined
      : ({ http: { secretPathSegments } } as unknown as ResolvedBymaxLoggerModuleOptions)

  new HttpExceptionFilter(logger, options).catch(new NotFoundException(`Cannot GET ${url}`), host)

  const [, message, , metadata] = warn.mock.calls[0] as [string, string, unknown, { url: string }]
  return { message, url: metadata.url }
}

describe('HttpExceptionFilter, a credential in the path', () => {
  it('replaces a built-in credential segment in the url and the message, with the logger alone', () => {
    const { message, url } = warned(`/auth/reset/${HEX}?x=1`)

    expect(url).toBe('/auth/reset/:redacted')
    expect(message).toBe('Cannot GET /auth/reset/:redacted')
  })

  it('replaces a segment the host pattern matches, and a built-in one too', () => {
    const { message, url } = warned(`/pay/tok_live_1/${HEX}`, [/^tok_/])

    expect(url).toBe('/pay/:redacted/:redacted')
    expect(message).toBe('Cannot GET /pay/:redacted/:redacted')
  })

  it('leaves a path without a credential as it is', () => {
    expect(warned('/pay/tok_live_1', []).url).toBe('/pay/tok_live_1')
  })
})
