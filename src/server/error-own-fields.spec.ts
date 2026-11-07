/**
 * Pins what an error's own fields do to a line: `errorOwnFields: 'all'` (the default) writes them
 * as before, except that a binary value becomes a size marker, and `'safe'` writes only an
 * allow-list of operational names plus the consumer's. Driven through the real Pino pipeline, on
 * the line a destination receives, with the error Node itself throws when a child process fails.
 *
 * Layer: server, tests.
 */
import { execFileSync } from 'node:child_process'
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

function pipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  service: PinoLoggerService
  entry: () => Record<string, any>
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
    entry: () => JSON.parse(lines[0] ?? '{}'),
    line: () => lines[0] ?? ''
  }
}

/**
 * The error Node throws when a child process exits with a status: its output is on the error as
 * Buffers. Node's own `Error` belongs to another realm than the one Jest runs the test in, so the
 * fields are copied onto an `Error` of this realm, which is what an application sees.
 */
function childProcessError(): Error {
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write("SECRET-OUT");process.stderr.write("SECRET-ERR");process.exit(3)'
      ],
      { stdio: 'pipe' }
    )
  } catch (error) {
    return Object.assign(new Error('Command failed'), error)
  }
  throw new Error('the child process was expected to fail')
}

const writes: [string, (s: PinoLoggerService, error: Error) => void][] = [
  ['the root err', (s, error) => s.errorStructured('KEY', error, 'u1')],
  [
    'a cause link',
    (s, error) => s.errorStructured('KEY', new Error('outer', { cause: error }), 'u1')
  ],
  [
    'an Error nested in the metadata',
    (s, error) => s.errorStructured('KEY', new Error('x'), 'u1', { nested: error })
  ]
]

describe.each(['all', 'safe'] as const)('errorOwnFields: %s', (mode) => {
  it.each(writes)('writes no byte array of a child process output, for %s', (_label, write) => {
    const { service, line } = pipeline({ errorOwnFields: mode })

    write(service, childProcessError())

    expect(line()).not.toContain('"type":"Buffer"')
    expect(line()).not.toContain('"data":[')
    expect(line()).not.toContain('"0":')
    expect(line()).not.toContain('SECRET-OUT')
  })
})

describe("errorOwnFields: 'all' (the default)", () => {
  it('writes a binary field as its size and keeps every other field', () => {
    const { service, entry } = pipeline()

    service.errorStructured('KEY', childProcessError(), 'u1')

    expect(entry().err.stdout).toBe('[Binary 10 bytes]')
    expect(entry().err.stderr).toBe('[Binary 10 bytes]')
    expect(entry().err.output).toEqual([null, '[Binary 10 bytes]', '[Binary 10 bytes]'])
    expect(entry().err.status).toBe(3)
  })

  it.each([
    ['a Uint8Array', () => new Uint8Array(4), '[Binary 4 bytes]'],
    ['a Float64Array', () => new Float64Array(2), '[Binary 16 bytes]'],
    ['a DataView', () => new DataView(new ArrayBuffer(6)), '[Binary 6 bytes]']
  ])('writes %s as its size', (_label, make, marker) => {
    const { service, entry } = pipeline()

    service.errorStructured('KEY', Object.assign(new Error('x'), { payload: make() }), 'u1')

    expect(entry().err.payload).toBe(marker)
  })

  it('keeps writing a field of any name, as before', () => {
    const { service, entry } = pipeline()

    service.errorStructured(
      'KEY',
      Object.assign(new Error('x'), { orderId: 'o-1', retries: 2 }),
      'u1'
    )

    expect(entry().err).toMatchObject({ orderId: 'o-1', retries: 2 })
  })

  it('leaves a Buffer in the caller metadata as it was', () => {
    const { service, entry } = pipeline()

    service.info('KEY', 'hello', 'u1', { raw: Buffer.from('ab') })

    expect(entry().raw).toEqual({ type: 'Buffer', data: [97, 98] })
  })
})

describe("errorOwnFields: 'safe'", () => {
  const error = (): Error =>
    Object.assign(
      new Error('boom', {
        cause: Object.assign(new Error('inner'), { orderId: 'o-2', code: 'ECONNRESET' })
      }),
      {
        code: 'ENOENT',
        errno: -2,
        syscall: 'open',
        statusCode: 500,
        orderId: 'o-1',
        path: '/srv/private/file',
        response: { body: 'quoted' }
      }
    )

  it('writes the operational names and drops the rest, at every depth', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured('KEY', error(), 'u1')

    expect(entry().err).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      statusCode: 500
    })
    expect(entry().err.orderId).toBeUndefined()
    expect(entry().err.path).toBeUndefined()
    expect(entry().err.response).toBeUndefined()
    expect(entry().err.cause).toMatchObject({ name: 'Error', message: 'inner', code: 'ECONNRESET' })
    expect(entry().err.cause.orderId).toBeUndefined()
  })

  it('keeps the type, message, stack and cause the logger derives', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured('KEY', error(), 'u1')

    expect(entry().err.type).toBe('Error')
    expect(entry().err.message).toBe('boom')
    expect(entry().err.stack).toContain('boom')
    expect(entry().err.cause.message).toBe('inner')
  })

  it('also writes the names the consumer lists, and nothing else', () => {
    const { service, entry } = pipeline({
      errorOwnFields: 'safe',
      errorOwnFieldNames: ['orderId', 'path']
    })

    service.errorStructured('KEY', error(), 'u1')

    expect(entry().err).toMatchObject({ orderId: 'o-1', path: '/srv/private/file', code: 'ENOENT' })
    expect(entry().err.response).toBeUndefined()
    expect(entry().err.cause.orderId).toBe('o-2')
  })

  it('applies to an Error nested in the metadata, including one that carries its own message', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured('KEY', new Error('root'), 'u1', {
      nested: Object.assign(new Error('n'), { code: 'E_N', orderId: 'o-3', message: 'own message' })
    })

    expect(entry().nested).toMatchObject({ code: 'E_N', message: 'own message' })
    expect(entry().nested.orderId).toBeUndefined()
  })

  it('applies to an error that was already sanitized, as the HTTP filter hands it over', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured(
      'KEY',
      { name: 'Error', message: 'm', code: 'E_X', orderId: 'o-4' } as unknown as Error,
      'u1'
    )

    expect(entry().err.code).toBe('E_X')
    expect(entry().err.orderId).toBeUndefined()
  })

  it('keeps the marker of a field that could not be read', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })
    const hostile = new Error('h')
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('no')
      }
    })

    service.errorStructured('KEY', hostile, 'u1')

    expect(entry().err._errorFieldsIncomplete).toBe(true)
  })

  it('still adds the type it derives when an own field named type is dropped', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured('KEY', new Error('root'), 'u1', {
      nested: Object.assign(new Error('n'), { type: 'custom' })
    })

    expect(entry().nested.type).toBe('Error')
  })

  it('applies to the members of an AggregateError', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })
    const member = Object.assign(new Error('m'), { code: 'E_M', orderId: 'o-5' })

    service.errorStructured('KEY', new AggregateError([member], 'many'), 'u1')

    expect(entry().err.errors[0]).toMatchObject({ message: 'm', code: 'E_M' })
    expect(entry().err.errors[0].orderId).toBeUndefined()
  })

  it('applies to a nested Error that has to be rebuilt because a field threw on its first read', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })
    const hostile = Object.assign(new Error('h'), { code: 'E_H', orderId: 'o-6' })
    let reads = 0
    Object.defineProperty(hostile, 'flaky', {
      enumerable: true,
      get() {
        if (reads++ === 0) throw new Error('first read')
        return 'second'
      }
    })

    service.errorStructured('KEY', new Error('root'), 'u1', { nested: hostile })

    expect(entry().nested).toMatchObject({ message: 'h', code: 'E_H' })
    expect(entry().nested.orderId).toBeUndefined()
    expect(entry().nested.flaky).toBeUndefined()
  })
})
