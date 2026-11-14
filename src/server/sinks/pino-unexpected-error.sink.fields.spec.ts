/**
 * Pins what the sink writes beside the error for a `5xx` `HttpException` and for a window summary:
 * the report's `repeated` count, the exception's `code` and its `details`. Driven through the real
 * Pino pipeline, so the assertions are on the line a destination receives and `details` is shown to
 * pass through the same redaction as any other metadata.
 *
 * Layer: server/sinks, tests.
 */
import { HttpException } from '@nestjs/common'

import { applyDefaults } from '../config/default-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

import { PinoUnexpectedErrorSink } from './pino-unexpected-error.sink'

/** A sink over the real factory, and the parsed lines its destination received. */
function pipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  sink: PinoUnexpectedErrorSink
  entries: () => Array<Record<string, any>>
} {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  const service = new PinoLoggerService(pino, resolveNameRedactor(options))
  return {
    sink: new PinoUnexpectedErrorSink(service),
    entries: () => lines.map((l) => JSON.parse(l))
  }
}

const COORDS = { method: 'POST', route: '/auth/login' } as const

describe('PinoUnexpectedErrorSink, the window summary', () => {
  it('writes how many occurrences the summary stands for', () => {
    const { sink, entries } = pipeline()

    sink.record({ ...COORDS, error: new Error('down'), repeated: 4 })

    expect(entries()[0]?.['repeated']).toBe(4)
  })

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['not a number', '4' as unknown as number],
    ['not finite', Number.POSITIVE_INFINITY],
    ['beyond a safe integer', Number.MAX_SAFE_INTEGER + 2]
  ])('writes no `repeated` key when it is %s', (_name, repeated) => {
    const { sink, entries } = pipeline()

    sink.record({
      ...COORDS,
      error: new Error('down'),
      ...(repeated === undefined ? {} : { repeated })
    })

    expect(Object.keys(entries()[0] ?? {})).not.toContain('repeated')
  })
})

describe('PinoUnexpectedErrorSink, an HttpException', () => {
  it('writes the code and the details of a flat response', () => {
    const { sink, entries } = pipeline()
    const error = new HttpException(
      {
        code: 'auth.service_unavailable',
        message: 'Auth Exception',
        details: { reason: 'offline' }
      },
      503
    )

    sink.record({ ...COORDS, error })

    expect(entries()[0]?.['errorCode']).toBe('auth.service_unavailable')
    expect(entries()[0]?.['errorDetails']).toEqual({ reason: 'offline' })
  })

  it('writes the code and the details of a nested response', () => {
    const { sink, entries } = pipeline()
    const error = new HttpException(
      { error: { code: 'queue.connection_timeout', details: { reason: 'offline' } } },
      503
    )

    sink.record({ ...COORDS, error })

    expect(entries()[0]?.['errorCode']).toBe('queue.connection_timeout')
    expect(entries()[0]?.['errorDetails']).toEqual({ reason: 'offline' })
  })

  it('censors a credential inside the details like any other metadata', () => {
    const { sink, entries } = pipeline()
    const error = new HttpException(
      {
        code: 'x.failed',
        details: {
          host: 'redis:6379',
          password: 'LEAK-PASSWORD',
          nested: { access_token: 'LEAK-TOKEN' }
        }
      },
      503
    )

    sink.record({ ...COORDS, error })

    const line = JSON.stringify(entries()[0])
    expect(line).not.toContain('LEAK-PASSWORD')
    expect(line).not.toContain('LEAK-TOKEN')
    expect(entries()[0]?.['errorDetails']?.host).toBe('redis:6379')
  })

  it('reads a flat response that also has a text `error` field, as NestJS writes it', () => {
    const { sink, entries } = pipeline()
    const error = new HttpException(
      {
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'auth.service_unavailable',
        details: { reason: 'offline' }
      },
      503
    )

    sink.record({ ...COORDS, error })

    expect(entries()[0]?.['errorCode']).toBe('auth.service_unavailable')
    expect(entries()[0]?.['errorDetails']).toEqual({ reason: 'offline' })
  })

  it('reads the flat code when an `error` object beside it has none', () => {
    const { sink, entries } = pipeline()
    const error = new HttpException(
      { code: 'queue.connection_timeout', error: { reason: 'offline' }, details: { attempt: 3 } },
      503
    )

    sink.record({ ...COORDS, error })

    expect(entries()[0]?.['errorCode']).toBe('queue.connection_timeout')
    expect(entries()[0]?.['errorDetails']).toEqual({ attempt: 3 })
  })

  it('writes the fields whatever errorOwnFields says', () => {
    const { sink, entries } = pipeline({ errorOwnFields: 'safe' })
    const error = new HttpException({ code: 'a.b', details: { reason: 'offline' } }, 503)

    sink.record({ ...COORDS, error })

    expect(entries()[0]?.['errorCode']).toBe('a.b')
    expect(entries()[0]?.['errorDetails']).toEqual({ reason: 'offline' })
  })

  it('caps the code at 128 characters', () => {
    const { sink, entries } = pipeline()

    sink.record({ ...COORDS, error: new HttpException({ code: 'c'.repeat(500) }, 503) })

    expect(entries()[0]?.['errorCode']).toBe('c'.repeat(128))
  })

  it.each([
    ['a string response', new HttpException('plain message', 503)],
    ['a response with no code', new HttpException({ message: 'x' }, 503)],
    ['a code that is not text', new HttpException({ code: 42, details: null }, 503)],
    ['details that are not an object', new HttpException({ code: 'a.b', details: 'text' }, 503)]
  ])('writes no unusable field for %s', (_name, error) => {
    const { sink, entries } = pipeline()

    sink.record({ ...COORDS, error })

    const keys = Object.keys(entries()[0] ?? {})
    expect(entries()).toHaveLength(1)
    expect(keys).not.toContain('errorDetails')
    if (typeof (error.getResponse() as { code?: unknown }).code !== 'string') {
      expect(keys).not.toContain('errorCode')
    }
  })

  it('still writes the report when getResponse throws or is not a function', () => {
    const hostile = Object.assign(new Error('boom'), {
      getResponse(): never {
        throw new Error('hostile')
      }
    })
    const notAFunction = Object.assign(new Error('boom2'), { getResponse: 'nope' })
    const { sink, entries } = pipeline()

    sink.record({ ...COORDS, error: hostile })
    sink.record({ ...COORDS, error: notAFunction })

    expect(entries()).toHaveLength(2)
    expect(Object.keys(entries()[0] ?? {})).not.toContain('errorCode')
    expect(Object.keys(entries()[1] ?? {})).not.toContain('errorCode')
  })

  it('does not read these fields from an error that is not an exception', () => {
    const { sink, entries } = pipeline()

    sink.record({ ...COORDS, error: Object.assign(new Error('driver'), { code: 'ECONNREFUSED' }) })

    expect(Object.keys(entries()[0] ?? {})).not.toContain('errorCode')
  })
})
