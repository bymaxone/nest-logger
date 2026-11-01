/**
 * Pins what a 5xx `HttpException` leaves in the log entry, through the real Pino pipeline: the
 * cause chain, and the response body that rides along as an own field, redacted by name.
 *
 * Layer: server/filters, tests. The integration spec beside it spies on `errorStructured`, so it
 * cannot see the entry that reaches a destination.
 */
import { HttpException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'

import { applyDefaults } from '../config/default-options'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

/** The one entry the filter logged for `exception`, parsed, with the raw line for secret checks. */
function logEntry(exception: unknown): { entry: Record<string, unknown>; line: string } {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  const filter = new HttpExceptionFilter(new PinoLoggerService(pino))
  const res = { status: () => res, json: () => undefined } as unknown as LoggableResponse
  const req = { method: 'POST', url: '/pay?token=query-secret', headers: {} } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost

  filter.catch(exception, host)

  const line = lines[0] ?? '{}'
  return { entry: JSON.parse(line) as Record<string, unknown>, line }
}

describe('HttpExceptionFilter — the entry for a 5xx HttpException', () => {
  const exception = (): HttpException =>
    new HttpException(
      { message: 'gateway down', password: 'body-secret', nested: { accessToken: 'token-secret' } },
      502,
      { cause: new Error('upstream timeout', { cause: new Error('socket hang up') }) }
    )

  it(/*
   * The cause chain reaches the entry: `errorStructured` hands the sanitized node to the `err`
   * serializer, which keeps `cause` at every level, so the root cause of a 502 is in the line.
   */
  'logs the cause chain', () => {
    const { entry } = logEntry(exception())

    expect(entry).toMatchObject({ logKey: 'HTTP_EXCEPTION_UNHANDLED', url: '/pay' })
    expect(entry['err']).toMatchObject({
      message: 'gateway down',
      cause: { message: 'upstream timeout', cause: { message: 'socket hang up' } }
    })
  })

  it(/*
   * The response body is an own field of the exception, so it travels with the error node, and
   * the node is walked by name like the rest of the record: a secret in the body is censored, and
   * so is the query string of the URL, which is stripped before it is logged.
   */
  'logs the response body with its secrets censored', () => {
    const { entry, line } = logEntry(exception())

    expect(entry['err']).toMatchObject({
      response: {
        message: 'gateway down',
        password: '[REDACTED]',
        nested: { accessToken: '[REDACTED]' }
      }
    })
    expect(line).not.toContain('body-secret')
    expect(line).not.toContain('token-secret')
    expect(line).not.toContain('query-secret')
  })
})
