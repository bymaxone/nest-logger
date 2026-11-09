/**
 * Pins that the message the filter logs does not carry the query string of the request. Nest words
 * its not-found message as `Cannot GET <originalUrl>`, with the whole URL, and an OAuth callback or
 * a reset link on a route that does not exist puts its `code`, `state` or `token` in it. The `url`
 * field has its query stripped; the message is free text, which name-based redaction cannot
 * censor. The response is the application's concern and is written as it was thrown.
 *
 * Layer: server/filters, tests.
 */
import { NotFoundException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'

import { applyDefaults } from '../config/default-options'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

const QUERY = '?code=SECRET-CODE&state=SECRET-STATE&token=SECRET-TOKEN&password=SECRET-PW'

/** The entry the filter logs, and the body it sends, for `exception` raised on `request`. */
function handled(
  exception: unknown,
  request: Partial<LoggableRequest>
): { entry: Record<string, unknown>; line: string; sent: Record<string, unknown> } {
  const lines: string[] = []
  const pino = buildPinoInstance(
    applyDefaults({ service: { name: 'app', version: '1.0.0' } }),
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  let sent: Record<string, unknown> = {}
  const res = {
    status: () => res,
    json: (body: Record<string, unknown>) => void (sent = body)
  } as unknown as LoggableResponse
  const req = { method: 'GET', headers: {}, ...request } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost

  new HttpExceptionFilter(new PinoLoggerService(pino)).catch(exception, host)

  const line = lines[0] ?? '{}'
  return { entry: JSON.parse(line) as Record<string, unknown>, line, sent }
}

describe('HttpExceptionFilter, the message it logs for a request that has a query string', () => {
  it.each([
    ['url', { url: `/missing${QUERY}` }, '/missing'],
    [
      'originalUrl, with the relative url of a mounted request',
      { url: `/missing${QUERY}`, originalUrl: `/api/missing${QUERY}` },
      '/api/missing'
    ],
    ['originalUrl alone', { originalUrl: `/api/missing${QUERY}`, url: '/' }, '/api/missing']
  ])('cuts the query out of the not-found message built from %s', (_name, request, path) => {
    const exception = new NotFoundException(`Cannot GET ${path}${QUERY}`)

    const { entry, line, sent } = handled(exception, request)

    expect(entry['msg']).toBe(`Cannot GET ${path}`)
    expect(line).not.toContain('SECRET')
    expect(sent['message']).toBe(`Cannot GET ${path}${QUERY}`)
  })

  it('cuts the query out of the message of an exposed client error', () => {
    const exception = Object.assign(new Error(`bad request for /x${QUERY}`), {
      status: 400,
      expose: true
    })

    const { entry, line, sent } = handled(exception, { url: `/x${QUERY}` })

    expect(entry['msg']).toBe('bad request for /x')
    expect(line).not.toContain('SECRET')
    expect(sent['message']).toBe(`bad request for /x${QUERY}`)
  })

  it('leaves a message that does not carry the query as it is', () => {
    const { entry } = handled(new NotFoundException('no such order'), { url: `/orders/1${QUERY}` })

    expect(entry['msg']).toBe('no such order')
  })
})
