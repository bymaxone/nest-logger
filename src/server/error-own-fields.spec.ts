/**
 * Pins what an error's own fields do to a line: `errorOwnFields: 'all'` (the default) writes every
 * own field and replaces a binary value by its size marker, and `'safe'` writes only an
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

  it('writes an Error with its own toJSON from its own fields, as the root err is written', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })
    const withToJson = Object.assign(new Error('n'), { path: '/p', actual: 'A', code: 'E_J' })
    Object.defineProperty(withToJson, 'toJSON', {
      value(this: { path: string; actual: string; code: string }) {
        return { path: this.path, actual: this.actual, code: this.code }
      }
    })

    service.errorStructured('KEY', new Error('root'), 'u1', { nested: withToJson })

    expect(entry().nested).toMatchObject({ code: 'E_J', message: 'n' })
    expect(entry().nested.path).toBeUndefined()
    expect(entry().nested.actual).toBeUndefined()
  })

  it('keeps the toJSON of a value that is not an Error', () => {
    const { service, entry } = pipeline({ errorOwnFields: 'safe' })

    service.errorStructured('KEY', new Error('root'), 'u1', {
      when: new Date(0),
      money: { amount: 5, toJSON: () => ({ formatted: '5.00' }) }
    })

    expect(entry().when).toBe('1970-01-01T00:00:00.000Z')
    expect(entry().money).toEqual({ formatted: '5.00' })
  })

  it("keeps the output of an Error's toJSON under 'all', as documented", () => {
    const { service, entry } = pipeline()
    const withToJson = Object.assign(new Error('n'), { path: '/p' })
    Object.defineProperty(withToJson, 'toJSON', {
      value(this: { path: string }) {
        return { fromToJson: this.path }
      }
    })

    service.errorStructured('KEY', new Error('root'), 'u1', { nested: withToJson })

    expect(entry().nested).toEqual({ fromToJson: '/p' })
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

describe("errorOwnFields: 'safe' when the name redaction does not walk the record", () => {
  const nestedError = (): Error =>
    Object.assign(new Error('n'), {
      code: 'E_N',
      orderId: 'o-9',
      stdout: Buffer.from('SECRET-OUT')
    })

  it.each([
    [
      'the default coverage is off and there are no redactPaths',
      { shouldDisableDefaultRedact: true }
    ],
    ['the strategy is paths', { redactStrategy: 'paths' as const }]
  ])('filters an Error nested in the metadata when %s', (_label, redaction) => {
    const { service, entry, line } = pipeline({ errorOwnFields: 'safe', ...redaction })

    service.errorStructured('KEY', new Error('root'), 'u1', { nested: nestedError() })

    expect(entry().nested).toMatchObject({ code: 'E_N' })
    expect(entry().nested.orderId).toBeUndefined()
    expect(entry().nested.stdout).toBeUndefined()
    expect(line()).not.toContain('"type":"Buffer"')
  })

  it.each([
    ['the default coverage is off', { shouldDisableDefaultRedact: true }],
    ['the strategy is paths', { redactStrategy: 'paths' as const }]
  ])("leaves the record alone under 'all' when %s, as before", (_label, redaction) => {
    const { service, entry } = pipeline(redaction)

    service.errorStructured('KEY', new Error('root'), 'u1', {
      nested: Object.assign(new Error('n'), { orderId: 'o-9' })
    })

    expect(entry().nested).toEqual({ orderId: 'o-9' })
  })

  it('writes the root err and a key with a serializer as it does when the names are covered', () => {
    const make = (): Error => {
      const leaf = Object.assign(new Error('leaf'), { code: 'E_L', orderId: 'o-1' })
      const mid = new Error('mid', { cause: leaf })
      return new AggregateError([mid, Object.assign(new Error('b'), { code: 'E_B' })], 'many', {
        cause: new Error('top', { cause: mid })
      })
    }
    const error = make()
    const covered = pipeline({ errorOwnFields: 'safe' })
    const bare = pipeline({ errorOwnFields: 'safe', shouldDisableDefaultRedact: true })
    const serializers = { wrapped: (input: unknown): unknown => ({ kept: input }) }
    const coveredWithSerializer = pipeline({ errorOwnFields: 'safe', serializers })
    const bareWithSerializer = pipeline({
      errorOwnFields: 'safe',
      shouldDisableDefaultRedact: true,
      serializers
    })

    covered.service.errorStructured('KEY', error, 'u1')
    bare.service.errorStructured('KEY', error, 'u1')
    coveredWithSerializer.service.info('KEY', 'hello', 'u1', { wrapped: 'x' })
    bareWithSerializer.service.info('KEY', 'hello', 'u1', { wrapped: 'x' })

    expect(bare.entry().err).toEqual(covered.entry().err)
    expect(bareWithSerializer.entry().wrapped).toEqual(coveredWithSerializer.entry().wrapped)
  })

  it.each([
    ['safe', undefined],
    ['all', 'o-9']
  ] as const)(
    "writes what a custom serializer returns as plain data under 'safe' and as it returned it under 'all', with no name covered (%s)",
    (mode, orderId) => {
      const { service, entry, line } = pipeline({
        errorOwnFields: mode,
        shouldDisableDefaultRedact: true,
        serializers: {
          thing: () => ({ inner: nestedError(), buf: Buffer.from('S'), fn: () => 1 })
        }
      })

      service.info('KEY', 'hello', 'u1', { thing: 1 })

      expect(entry().thing.inner.orderId).toBe(orderId)
      if (mode === 'safe') {
        expect(entry().thing.buf).toBe('[Binary 1 bytes]')
        expect(entry().thing.fn).toBeUndefined()
        expect(line()).not.toContain('"data"')
      }
    }
  )
})

describe('an Error with a toJSON that a serializer returns', () => {
  const returned = (): Error => {
    const error = Object.assign(new Error('n'), { password: 'SECRET', actual: 'PRIVATE' })
    Object.defineProperty(error, 'toJSON', {
      value(this: { password: string; actual: string }) {
        return { password: this.password, actual: this.actual }
      }
    })
    return error
  }

  it.each(['all', 'safe'] as const)(
    "is censored by name when it is the root err or sits under a key with a serializer, under '%s'",
    (mode) => {
      const root = pipeline({ errorOwnFields: mode })
      const keyed = pipeline({
        errorOwnFields: mode,
        serializers: { thing: (input: unknown) => ({ seen: input }) }
      })

      root.service.errorStructured('KEY', returned(), 'u1')
      keyed.service.info('KEY', 'hello', 'u1', { thing: returned() })

      expect(root.line()).not.toContain('SECRET')
      expect(keyed.line()).not.toContain('SECRET')
    }
  )

  it.each([
    ['all', '[REDACTED]'],
    ['safe', '"inner":{"type":"Error","message":"n"']
  ] as const)("never writes what its toJSON returns, under '%s'", (mode, written) => {
    const { service, line } = pipeline({
      errorOwnFields: mode,
      serializers: { thing: () => ({ inner: returned() }) }
    })

    service.info('KEY', 'hello', 'u1', { thing: 1 })

    expect(line()).not.toContain('SECRET')
    expect(line()).toContain(written)
  })
})

describe("a serializer under 'safe' receives plain data", () => {
  it('sees an error-like object holding only the fields the policy allows', () => {
    let seen: unknown
    const { service } = pipeline({
      errorOwnFields: 'safe',
      serializers: {
        thing: (input: unknown): unknown => {
          seen = input
          return 'done'
        }
      }
    })

    service.info('KEY', 'hello', 'u1', {
      thing: Object.assign(new Error('n', { cause: new Error('c') }), {
        code: 'E_T',
        orderId: 'o-1'
      })
    })

    expect(seen).not.toBeInstanceOf(Error)
    expect(seen).toMatchObject({ name: 'Error', message: 'n', code: 'E_T' })
    expect(seen).not.toHaveProperty('orderId')
    expect(seen).toMatchObject({ cause: { name: 'Error', message: 'c' } })
  })

  it('applies toJSON the way the stringifier reads it, through a Proxy get trap', () => {
    let seen: unknown
    const { service } = pipeline({
      errorOwnFields: 'safe',
      serializers: {
        thing: (input: unknown): unknown => {
          seen = input
          return 'done'
        }
      }
    })
    const proxied = new Proxy(
      { hidden: 1 },
      {
        get: (target, key, receiver) =>
          key === 'toJSON' ? () => ({ kept: 2 }) : Reflect.get(target, key, receiver)
      }
    )

    service.info('KEY', 'hello', 'u1', { thing: proxied })

    expect(seen).toEqual({ kept: 2 })
  })
})

describe("errorOwnFields 'safe' writes plain data however the redaction is configured", () => {
  const configurations: [string, Partial<BymaxLoggerModuleOptions>][] = [
    ['names, defaults', {}],
    ['names, defaults off', { shouldDisableDefaultRedact: true }],
    [
      'names, defaults off, a path',
      { shouldDisableDefaultRedact: true, redactPaths: ['meta.secret'] }
    ],
    ['names, defaults and a path', { redactPaths: ['meta.secret'] }],
    ['paths, defaults', { redactStrategy: 'paths' }],
    ['paths, defaults off', { redactStrategy: 'paths', shouldDisableDefaultRedact: true }],
    [
      'paths, defaults off, a path',
      { redactStrategy: 'paths', shouldDisableDefaultRedact: true, redactPaths: ['meta.secret'] }
    ],
    ['paths, defaults and a path', { redactStrategy: 'paths', redactPaths: ['meta.secret'] }]
  ]
  const payload = (): Record<string, unknown> => ({
    buf: Buffer.from('S'),
    run: () => 1,
    err: Object.assign(new Error('n'), { orderId: 'o-1', code: 'E_P', stdout: Buffer.from('S') })
  })
  const channels: [string, (s: PinoLoggerService) => void][] = [
    ['metadata', (s) => s.info('KEY', 'hello', 'u1', { meta: payload() })],
    [
      'the root err',
      (s) =>
        s.errorStructured(
          'KEY',
          Object.assign(new Error('r'), { orderId: 'o-1', stdout: Buffer.from('S') }),
          'u1'
        )
    ],
    ['what a serializer returns', (s) => s.info('KEY', 'hello', 'u1', { thing: 1 })],
    ['bindings of a child', (s) => s.child({ meta: payload() }).info('KEY', 'hello', 'u1')]
  ]

  describe.each(configurations)('%s', (_name, extra) => {
    it.each(channels)('has no byte array, function or dropped field, for %s', (_channel, write) => {
      const { service, line } = pipeline({
        errorOwnFields: 'safe',
        serializers: { thing: () => ({ meta: payload() }) },
        ...extra
      })

      write(service)

      const keys = new Set<string>()
      JSON.parse(line(), function (key, value: unknown) {
        keys.add(key)
        return value
      })
      expect(line()).not.toContain('"data"')
      expect(keys.has('orderId')).toBe(false)
      expect(keys.has('stdout')).toBe(false)
      expect(keys.has('run')).toBe(false)
      expect(line()).toContain('KEY')
    })
  })
})

describe('the width cap of an AggregateError reports the same count in both modes', () => {
  it.each(['all', 'safe'] as const)(
    "counts the 90 members left out of a hundred once, for the root err and a nested one, under '%s'",
    (mode) => {
      const { service, entry } = pipeline({ errorOwnFields: mode })
      const members = Array.from(
        { length: 100 },
        (_member, index) => new Error(`m${String(index)}`)
      )

      service.errorStructured('KEY', new AggregateError(members, 'many'), 'u1', {
        nested: new AggregateError(members, 'again')
      })

      expect(entry().err.errors).toHaveLength(11)
      expect(entry().err.errors.at(-1)._omitted).toBe(90)
      expect(entry().nested.errors).toHaveLength(11)
      expect(entry().nested.errors.at(-1)._omitted).toBe(90)
    }
  )
})
