/**
 * Pins what the library's own log entry says about an error the body parser raised: a fixed text
 * for each type that may quote the request body, with the parser `type` beside it, and nothing of
 * the body. The errors are the real parser's, read from a request stream with no socket; the
 * response body keeps the parser's message, which is the application's concern. The forms of body
 * are the ones that put text in the parser's message: a body that is not an object, and a value
 * left unquoted.
 *
 * Layer: server/filters, tests.
 */
import { BadRequestException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { json, urlencoded } from 'express'
import type { RequestHandler } from 'express'
import { Readable } from 'node:stream'

import { applyDefaults } from '../config/default-options'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import { recordParserErrorMiddleware } from '../middlewares/record-parser-error.middleware'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

import { HttpExceptionFilter } from './http-exception.filter'

const SECRET = 'hunter2-SENTINEL'

/** The error the given body parser passes to `next` for a request carrying `body`. */
function parserError(
  parser: RequestHandler,
  body: string,
  headers: Record<string, string>
): unknown {
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
    method: 'POST',
    url: '/pay'
  })
  let caught: unknown
  parser(req as never, {} as never, (error?: unknown) => {
    caught = error
  })
  return new Promise((resolve) => setImmediate(() => setTimeout(() => resolve(caught), 20)))
}

/** The entry and the response the filter produces for `exception`. */
function handled(
  exception: unknown,
  request: object = {}
): {
  entry: Record<string, unknown>
  line: string
  sent: { status: number; body: Record<string, unknown> }
} {
  const lines: string[] = []
  const pino = buildPinoInstance(
    applyDefaults({ service: { name: 'app', version: '1.0.0' } }),
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  const sent = { status: 0, body: {} as Record<string, unknown> }
  const res = {
    status: (code: number) => ((sent.status = code), res),
    json: (body: Record<string, unknown>) => void (sent.body = body)
  } as unknown as LoggableResponse
  const req = { method: 'POST', url: '/pay', headers: {}, ...request } as LoggableRequest
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req })
  } as unknown as ArgumentsHost

  new HttpExceptionFilter(new PinoLoggerService(pino)).catch(exception, host)

  const line = lines[0] ?? '{}'
  return { entry: JSON.parse(line) as Record<string, unknown>, line, sent }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('HttpExceptionFilter, the log entry for an error of the body parser', () => {
  it.each([
    ['a body that is not an object', SECRET],
    ['a value left unquoted', `{"password":${SECRET}}`],
    ['an unquoted value in a list', `{"items":[${SECRET}]}`]
  ])('writes a fixed text and the type for malformed JSON, %s', async (_name, body) => {
    const error = await parserError(json(), body, JSON_HEADERS)
    const req = {}
    recordParserErrorMiddleware(error, req, {}, jest.fn())

    // Nest's router turns a SyntaxError into this before any filter runs
    // (`RoutesResolver.mapExternalException`); test/e2e/body-parser-errors.e2e-spec.ts drives the
    // real thing.
    const { entry, line, sent } = handled(new BadRequestException((error as Error).message), req)

    expect(sent.status).toBe(400)
    expect(entry['msg']).toBe('request body could not be parsed')
    expect(entry['bodyParserType']).toBe('entity.parse.failed')
    expect(entry['status']).toBe(400)
    expect(line).not.toContain('hunter')
    expect(String(sent.body['message'])).toContain('is not valid JSON')
  })

  it('logs the message of a 400 the application raised, when no parser error was recorded', () => {
    const { entry } = handled(new BadRequestException('own message'), {})

    expect(entry['msg']).toBe('own message')
    expect(entry).not.toHaveProperty('bodyParserType')
  })

  it('writes a fixed text and the type when the verify function refuses the body', async () => {
    const parser = json({
      verify: (_req, _res, buffer) => {
        throw new Error(`verify says ${buffer.toString()}`)
      }
    })
    const error = await parserError(parser, SECRET, JSON_HEADERS)

    const { entry, line, sent } = handled(error)

    expect(sent.status).toBe(403)
    expect(entry['msg']).toBe('request body verification failed')
    expect(entry['bodyParserType']).toBe('entity.verify.failed')
    expect(line).not.toContain(SECRET)
  })

  it.each([
    [
      'a content encoding',
      { ...JSON_HEADERS, 'content-encoding': `x-${SECRET}` },
      'encoding.unsupported'
    ],
    ['a charset', { 'content-type': `application/json; charset=${SECRET}` }, 'charset.unsupported']
  ])(
    'writes the type beside the fixed text for %s the parser does not support',
    async (_n, headers, type) => {
      const error = await parserError(json(), '{"a":1}', headers)

      const { entry, line } = handled(error)

      expect(entry['bodyParserType']).toBe(type)
      expect(line).not.toMatch(/hunter/i)
    }
  )

  it.each([
    [
      'a body over the limit',
      json({ limit: 10 }),
      JSON.stringify({ a: SECRET }),
      JSON_HEADERS,
      413
    ],
    [
      'too many parameters',
      urlencoded({ extended: false, parameterLimit: 1 }),
      'a=1&b=2',
      { 'content-type': 'application/x-www-form-urlencoded' },
      413
    ]
  ])(
    'leaves the entry for %s as it is, with no type field',
    async (_n, parser, body, headers, code) => {
      const error = await parserError(parser, body, headers)

      const { entry, sent } = handled(error)

      expect(sent.status).toBe(code)
      expect(entry['msg']).toBe(sent.body['message'])
      expect(entry).not.toHaveProperty('bodyParserType')
    }
  )
})
