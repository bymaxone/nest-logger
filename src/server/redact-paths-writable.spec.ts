/**
 * Pins that a log call never throws on JSON-shaped metadata, under either redaction strategy, and
 * that the secret in it is still censored. Under `redactStrategy: 'paths'` the record reaches
 * `@pinojs/redact` as the copy the name walk built, and that module assigns the censor into the
 * object it is given, in strict mode: a copy whose properties are not writable throws there.
 * Driven through the real Pino pipeline, on the line a destination receives.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SECRET = 'SECRET-VALUE'

function pipeline(extra: Partial<BymaxLoggerModuleOptions>): {
  service: PinoLoggerService
  line: () => string
} {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino, resolveNameRedactor(options)),
    line: () => lines[0] ?? ''
  }
}

/** The shapes that threw under `'paths'`, and controls that did not; every secret is `SECRET`. */
const leaf = JSON.stringify({ inner: SECRET })
const shapes: [string, string][] = [
  ['a.cookie.token is an object', `{"a":{"cookie":{"token":${leaf}}}}`],
  ['a.b.cookie.token is an object', `{"a":{"b":{"cookie":{"token":${leaf}}}}}`],
  ['a.b.cookie.token is a string', `{"a":{"b":{"cookie":{"token":"${SECRET}"}}}}`],
  ['a.b.cookie.password is an object', `{"a":{"b":{"cookie":{"password":${leaf}}}}}`],
  ['a.b.authorization.token is an object', `{"a":{"b":{"authorization":{"token":${leaf}}}}}`],
  ['a request-shaped headers.cookie', `{"body":{"headers":{"cookie":{"token":"${SECRET}"}}}}`],
  ['a deep wrapper around cookie.token', `{"w":{"p":{"m":{"cookie":{"token":${leaf}}}}}}`],
  ['a.b.password.token (control)', `{"a":{"b":{"password":{"token":${leaf}}}}}`],
  ['a.b.c.token (control)', `{"a":{"b":{"c":{"token":${leaf}}}}}`],
  ['a.b.c.password is a string (control)', `{"a":{"b":{"c":{"password":"${SECRET}"}}}}`],
  ['a password in a list (control)', `{"body":{"user":{"profile":{"password":["${SECRET}"]}}}}`]
]

const configurations: [string, Partial<BymaxLoggerModuleOptions>][] = [
  ['names, defaults', {}],
  ['paths, defaults', { redactStrategy: 'paths' }],
  [
    'paths, defaults and a path of the consumer',
    { redactStrategy: 'paths', redactPaths: ['a.b.c'] }
  ]
]

describe.each(configurations)('JSON-shaped metadata, with %s', (_name, extra) => {
  it.each(shapes)('does not throw and writes no secret when %s', (_shape, json) => {
    const { service, line } = pipeline(extra)

    expect(() => service.info('KEY', 'hello', 'u1', JSON.parse(json))).not.toThrow()

    expect(line()).not.toContain(SECRET)
  })
})

describe('an Error in the metadata, under redactStrategy paths', () => {
  it('does not throw and writes no secret when the Error is frozen and holds a secret', () => {
    const { service, line } = pipeline({ redactStrategy: 'paths' })
    const error = Object.freeze(Object.assign(new Error('boom'), { cookie: { token: SECRET } }))

    expect(() => service.info('KEY', 'hello', 'u1', { a: { err: error } })).not.toThrow()

    expect(line()).not.toContain(SECRET)
  })

  it('does not throw and writes no secret when the Error is logged as the error itself', () => {
    const { service, line } = pipeline({ redactStrategy: 'paths' })
    const error = Object.assign(new Error('boom'), {
      meta: { cookie: { token: SECRET } },
      authorization: { password: SECRET }
    })

    expect(() => service.error(error)).not.toThrow()

    expect(line()).not.toContain(SECRET)
  })

  it.each([['err.toJSON'], ['*.toJSON'], ['a.*.toJSON']])(
    'does not throw and runs no hook when the consumer path %s targets the toJSON of an Error',
    (path) => {
      class Hooked extends Error {
        toJSON(): object {
          return { password: SECRET }
        }
      }
      const { service, line } = pipeline({ redactStrategy: 'paths', redactPaths: [path] })
      const error = new Hooked('boom')

      expect(() =>
        service.info('KEY', 'hello', 'u1', { err: error, a: { err: error } })
      ).not.toThrow()

      expect(line()).not.toContain(SECRET)
    }
  )

  it.each([
    ['stack', false],
    ['stack', true],
    ['message', true],
    ['cause', true]
  ])(
    'does not throw when a consumer path targets the %s of an Error (frozen: %s) beside a specific path',
    (field, frozen) => {
      const { service, line } = pipeline({
        redactStrategy: 'paths',
        redactPaths: ['a.x.unrelated', `a.*.err.${field}`]
      })
      const error = new Error(SECRET, { cause: { q: SECRET } })
      if (frozen) Object.freeze(error)

      expect(() => service.info('KEY', 'hello', 'u1', { a: { x: { err: error } } })).not.toThrow()
    }
  )

  it.each([
    ['non-enumerable', false],
    ['enumerable', true]
  ])(
    'does not throw and writes no secret for a %s accessor with no setter, beside a wildcard path',
    (_kind, enumerable) => {
      const { service, line } = pipeline({
        redactStrategy: 'paths',
        redactPaths: ['a.x.unrelated', 'a.*.err.stack']
      })
      const error = new Error('boom')
      Object.defineProperty(error, 'password', { get: () => SECRET, enumerable })

      expect(() => service.info('KEY', 'hello', 'u1', { a: { x: { err: error } } })).not.toThrow()

      expect(line()).not.toContain(SECRET)
      if (enumerable) expect(line()).toContain('"password":"[REDACTED]"')
    }
  )

  it('leaves the cause of the caller as it was, the same object with its own descriptors', () => {
    const { service, line } = pipeline({
      redactStrategy: 'paths',
      redactPaths: ['a.x.unrelated', 'a.*.err.cause']
    })
    const cause = Object.assign(new Error('inner'), { password: SECRET })
    const error = new Error('outer', { cause })
    const before = Object.getOwnPropertyDescriptors(cause)

    service.info('KEY', 'hello', 'u1', { a: { x: { err: error } } })

    expect(error.cause).toBe(cause)
    expect(Object.getOwnPropertyDescriptors(cause)).toEqual(before)
    expect(cause.password).toBe(SECRET)
    expect(line()).not.toContain(SECRET)
  })
})
