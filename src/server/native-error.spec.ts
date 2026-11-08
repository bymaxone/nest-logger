/**
 * Pins that an error from another realm is written as the error it is. `instanceof Error` is false
 * for an `Error` made in a `vm` context or by a Node core module under a test runner, and its
 * `name` and `message` are non-enumerable, so it must be recognised as a native error to keep them.
 *
 * Layer: server, tests.
 */
import { runInNewContext } from 'node:vm'
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { isErrorLike } from './utils/sanitize-error.util'

function pipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  service: PinoLoggerService
  entry: () => Record<string, any>
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
    entry: () => JSON.parse(lines[0] ?? '{}')
  }
}

/** An `Error` made in another realm, with an own field and a cause from that realm. */
const foreign = (): Error =>
  runInNewContext(
    `(() => { const e = new TypeError('boom', { cause: new RangeError('inner') }); e.code = 'E_F'; return e })()`
  ) as Error

describe.each(['all', 'safe'] as const)(
  'an error from another realm, errorOwnFields %s',
  (mode) => {
    it("is not an instance of this realm's Error", () => {
      expect(foreign() instanceof Error).toBe(false)
    })

    it('is written with its type, message, stack, cause and own field when nested in the metadata', () => {
      const { service, entry } = pipeline({ errorOwnFields: mode })

      service.info('KEY', 'hello', 'u1', { nested: foreign() })

      expect(entry().nested).toMatchObject({ type: 'TypeError', message: 'boom', code: 'E_F' })
      expect(entry().nested.stack).toContain('boom')
      expect(entry().nested.cause).toMatchObject({ message: 'inner' })
    })

    it('is written as the root err', () => {
      const { service, entry } = pipeline({ errorOwnFields: mode })

      service.errorStructured('KEY', foreign(), 'u1')

      expect(entry().err).toMatchObject({ type: 'TypeError', message: 'boom', code: 'E_F' })
    })
  }
)

describe('an error from another realm that carries bytes or hides its shape', () => {
  it('is written with a binary own field as its size', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe', errorOwnFieldNames: ['stdout'] })
    const error = runInNewContext(
      `(() => { const e = new TypeError('boom'); e.stdout = [bytes]; return e })()`,
      { bytes: Buffer.from('ab') }
    ) as Error

    service.info('KEY', 'hello', 'u1', { nested: error, other: 1 })

    expect(entry().nested.stdout).toEqual(['[Binary 2 bytes]'])
  })

  it('is handed to a serializer with a binary list as sizes', () => {
    let seen: unknown
    const { service, entry } = pipeline({
      redactPaths: ['password'],
      serializers: {
        conn: (value: unknown) => {
          seen = (value as { output: unknown }).output
          return value
        }
      }
    })
    const error = runInNewContext(
      `(() => { const e = new TypeError('boom'); e.output = [bytes]; return e })()`,
      { bytes: Buffer.from('ab') }
    ) as Error

    service.info('KEY', 'hello', 'u1', { conn: error })

    expect(seen).toEqual(['[Binary 2 bytes]'])
    expect(entry().conn.output).toEqual(['[Binary 2 bytes]'])
  })

  it('is still an error when reading its name throws', () => {
    const error = runInNewContext(
      `(() => { const e = new TypeError('boom'); Object.defineProperty(e, 'name', { get() { throw new Error('x') } }); return e })()`
    ) as Error

    expect(isErrorLike(error)).toBe(true)
  })
})
