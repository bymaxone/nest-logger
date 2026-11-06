/**
 * Pins how an `Error` outside a record-root key with a serializer is written: as data, by the walk
 * alone, so `toJSON`, `cause` and `errors` are read once and censored by name. Driven through the
 * real Pino pipeline, so the assertions are on the line a destination receives.
 *
 * Layer: server, tests. The shapes judged against 1.4.8 are in the `nested-error-shapes` specs.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

/** A logger over the real factory whose destination captures each line. */
function createPipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  service: PinoLoggerService
  lines: string[]
} {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  return { service: new PinoLoggerService(pino, resolveNameRedactor(options)), lines }
}

/** Logs `metadata` beside a healthy root error and returns the parsed entry and its line. */
function logWith(
  metadata: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): { entry: Record<string, any>; line: string } {
  const { service, lines } = createPipeline(extra)
  service.errorStructured('KEY', new Error('root'), 'u1', metadata)
  return { entry: JSON.parse(lines[0] ?? '{}'), line: lines[0] ?? '' }
}

/** An HTTP-client error: its `toJSON` keeps the request, and the raw header text, out. */
class HttpFailure extends Error {
  readonly config = { url: '/x', headers: { Authorization: 'Bearer config-secret' } }
  readonly request = { _header: 'GET / HTTP/1.1\r\nAuthorization: Bearer LEAKHDR' }
  constructor() {
    super('connect refused')
    this.name = 'HttpFailure'
  }
  toJSON(): Record<string, unknown> {
    return { message: this.message, name: this.name, code: 'ECONNREFUSED' }
  }
}

describe('an Error outside a serialized root key', () => {
  it.each([
    ['a metadata key', (e: Error) => ({ inner: e }), (x: any) => x.inner],
    ['an array', (e: Error) => ({ a: { b: [e] } }), (x: any) => x.a.b[0]],
    [
      'an own field of another Error',
      (e: Error) => ({ inner: Object.assign(new Error('outer'), { wrapped: e }) }),
      (x: any) => x.inner.wrapped
    ]
  ])('is written with type, message and stack when it sits in %s', (_label, wrap, pick) => {
    /*
     * `JSON.stringify` omits an Error's non-enumerable message and stack, so an Error left as it
     * is would serialize as `{}`. The walk writes the same fields the root `err` carries.
     */
    const { entry } = logWith(wrap(new Error('nested boom')))

    expect(pick(entry)).toMatchObject({ type: 'Error', message: 'nested boom' })
    expect(pick(entry).stack).toContain('nested boom')
  })

  it('keeps the cause chain and AggregateError.errors, each link written the same way', () => {
    const { entry } = logWith({
      chain: new Error('top', { cause: new Error('root cause') }),
      many: new AggregateError([new Error('first'), new Error('second')], 'agg')
    })

    expect(entry.chain).toMatchObject({
      message: 'top',
      cause: { type: 'Error', message: 'root cause' }
    })
    expect(entry.many).toMatchObject({
      type: 'AggregateError',
      errors: [{ message: 'first' }, { message: 'second' }]
    })
  })

  it('writes a cause that is not an Error as data, never as text', () => {
    const { entry, line } = logWith({
      plain: new Error('a', { cause: { status: 500, password: 'p', note: 'kept' } }),
      text: new Error('b', { cause: { toString: () => 'Bearer TOSTR' } })
    })

    expect(entry.plain.cause).toStrictEqual({ status: 500, password: '[REDACTED]', note: 'kept' })
    expect(line).not.toContain('TOSTR')
  })

  it('writes a string cause as it writes a message', () => {
    // Same treatment as `message`, which the root `err` also writes: secrets do not belong in either.
    const { entry } = logWith({ inner: new Error('o', { cause: 'plain reason' }) })

    expect(entry.inner.cause).toBe('plain reason')
  })

  it('keeps a subclass own fields, censored by name, and puts a colliding `type` under fields', () => {
    class PayError extends Error {
      readonly code = 'E_PAY'
      readonly password = 'own-secret'
      readonly detail = { token: 'detail-secret' }
      readonly type = 'validation'
    }

    const { entry, line } = logWith({ inner: new PayError('pay failed') })

    expect(entry.inner).toMatchObject({
      type: 'Error',
      message: 'pay failed',
      code: 'E_PAY',
      password: '[REDACTED]',
      detail: { token: '[REDACTED]' },
      fields: { type: 'validation' }
    })
    expect(line).not.toContain('own-secret')
    expect(line).not.toContain('detail-secret')
  })

  it('censors a secret held by a link of the chain', () => {
    const link = Object.assign(new Error('link'), { accessToken: 'cause-secret' })

    const { entry, line } = logWith({ inner: new Error('top', { cause: link }) })

    expect(entry.inner.cause.accessToken).toBe('[REDACTED]')
    expect(line).not.toContain('cause-secret')
  })

  it('writes the chain the same depth the root err does, then a marker', () => {
    let chain = new Error('d0')
    for (let level = 1; level <= 8; level++) chain = new Error(`d${level}`, { cause: chain })

    const { entry } = logWith({ inner: chain })

    expect(entry.inner.cause.cause.cause).toMatchObject({ message: 'd5' })
    expect(entry.inner.cause.cause.cause.cause).toStrictEqual({
      _truncated: true,
      _reason: 'cause-depth-exceeded'
    })
  })

  it('writes ten members of errors and one marker for the rest', () => {
    const many = Array.from({ length: 12 }, (_, index) => new Error(`m${index}`))

    const { entry } = logWith({ inner: new AggregateError(many, 'agg') })

    expect(entry.inner.errors).toHaveLength(11)
    expect(entry.inner.errors[9]).toMatchObject({ message: 'm9' })
    expect(entry.inner.errors[10]).toStrictEqual({
      _truncated: true,
      _reason: 'aggregate-width-exceeded',
      _omitted: 2
    })
  })

  it('ends an Error that reaches itself at the cycle marker, and writes a shared one in full twice', () => {
    const cyclic: Error & { self?: unknown } = new Error('cyc')
    cyclic.self = cyclic
    const shared = new Error('shared')

    const { entry } = logWith({ loop: cyclic, first: shared, second: shared })

    expect(entry.loop).toMatchObject({ message: 'cyc', self: '[Circular]' })
    expect(entry.first.message).toBe('shared')
    expect(entry.second.message).toBe('shared')
  })

  it('drops an Error below the walk depth ceiling and still emits the entry', () => {
    let nested: Record<string, unknown> = { leaf: new Error('too deep') }
    for (let level = 0; level < 105; level++) nested = { next: nested }

    const { entry, line } = logWith({ deep: nested })

    expect(entry.logKey).toBe('KEY')
    expect(line).not.toContain('too deep')
  })
})

describe('an Error that defines toJSON', () => {
  it('is written as its toJSON decides, with the request kept out', () => {
    const { entry, line } = logWith({ inner: new HttpFailure() })

    expect(entry.inner).toStrictEqual({
      message: 'connect refused',
      name: 'HttpFailure',
      code: 'ECONNREFUSED'
    })
    expect(line).not.toContain('LEAKHDR')
  })

  it.each([
    ['cause', (e: Error) => Object.assign(new Error('o'), { cause: e })],
    ['a non-enumerable cause', (e: Error) => new Error('o', { cause: e })],
    ['errors', (e: Error) => new AggregateError([e], 'agg')]
  ])('is written as its toJSON decides when it is the %s of another Error', (_label, wrap) => {
    // The credential that reached the line in clear through the link of a chain.
    const { line } = logWith({ inner: wrap(new HttpFailure()) })

    expect(line).toContain('ECONNREFUSED')
    expect(line).not.toContain('LEAKHDR')
    expect(line).not.toContain('config-secret')
  })

  it('walks what toJSON returns, so a secret in it is censored by name', () => {
    const error = Object.assign(new Error('x'), { toJSON: () => ({ accessToken: 'json-secret' }) })

    const { entry, line } = logWith({ inner: error })

    expect(entry.inner).toStrictEqual({ accessToken: '[REDACTED]' })
    expect(line).not.toContain('json-secret')
  })
})

describe('an Error that cannot be fully read', () => {
  it('degrades to SanitizeFailed when its name or message cannot be read', () => {
    const error = Object.defineProperty(new Error('boom'), 'message', {
      get: () => {
        throw new Error('exploded')
      }
    })

    const { entry } = logWith({ inner: error })

    expect(entry.logKey).toBe('KEY')
    expect(entry.inner).toMatchObject({ type: 'SanitizeFailed' })
  })

  it('keeps the rest and marks the node when one field cannot be read', () => {
    const error = Object.defineProperty(Object.assign(new Error('boom'), { keep: 'k' }), 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('exploded')
      }
    })

    const { entry } = logWith({ inner: error })

    expect(entry.inner).toMatchObject({
      type: 'Error',
      message: 'boom',
      keep: 'k',
      _errorFieldsIncomplete: true
    })
  })

  it.each([
    [
      'only its toJSON',
      { toJSON: true },
      { type: 'Error', message: 'boom', _errorFieldsIncomplete: true }
    ],
    ['its toJSON and its name', { toJSON: true, name: true }, { type: 'SanitizeFailed' }]
  ])('falls back to the head when %s cannot be read', (_label, hostile, expected) => {
    // The failure comes before the head is read, so the head is read once, in the fallback.
    const error = new Error('boom')
    const explode = {
      get: (): never => {
        throw new Error('exploded')
      }
    }
    Object.defineProperty(error, 'toJSON', explode)
    if ('name' in hostile) Object.defineProperty(error, 'name', explode)

    const { entry } = logWith({ inner: error })

    expect(entry.logKey).toBe('KEY')
    expect(entry.inner).toMatchObject(expected)
  })

  it('keeps only the parts of the head that are text when walking a field fails', () => {
    const odd = Object.assign(
      new Error('o', {
        cause: {
          get field(): never {
            throw new Error('exploded')
          }
        }
      }),
      {
        name: 42,
        message: { not: 'text' }
      }
    )

    const { entry } = logWith({ inner: odd })

    expect(entry.inner).toStrictEqual({ _errorFieldsIncomplete: true })
  })

  it('writes the head alone and marks it when walking a field fails', () => {
    const hostile = {
      get field(): never {
        throw new Error('exploded')
      }
    }

    const { entry } = logWith({ inner: new Error('o', { cause: hostile }) })

    expect(entry.logKey).toBe('KEY')
    expect(entry.inner).toStrictEqual({ type: 'Error', message: 'o', _errorFieldsIncomplete: true })
  })
})

describe('what a record-root key with a serializer receives', () => {
  const serializers = {
    error: (input: unknown): unknown => {
      const held = input as { inner?: unknown; list?: unknown[] } | null
      return {
        innerIsError: held?.inner instanceof Error,
        listIsError: held?.list?.[0] instanceof Error
      }
    },
    wrapped: (input: unknown): unknown => ({ original: input })
  }

  it.each([
    ['an object', { inner: new Error('x') }, { innerIsError: true }],
    ['an array', { list: [new Error('x')] }, { listIsError: true }]
  ])('hands the serializer an Error held inside %s as an instance', (_label, held, expected) => {
    const { entry } = logWith({ error: held }, { serializers })

    expect(entry.error).toMatchObject(expected)
  })

  it('does the same for the bindings of a child logger, and writes the data elsewhere', () => {
    const { service, lines } = createPipeline({ serializers })

    service.child({ error: { inner: new Error('x') }, other: new Error('y') }).log('hello')

    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry.error).toMatchObject({ innerIsError: true })
    expect(entry.other).toMatchObject({ type: 'Error', message: 'y' })
  })

  it('writes an Error under a nested key of the same name as data', () => {
    const { entry } = logWith(
      { outer: { error: new Error('deep'), err: new Error('deeper') } },
      { serializers }
    )

    expect(entry.outer).toMatchObject({ error: { type: 'Error' }, err: { type: 'Error' } })
  })

  it('writes an Error that a serializer returns as data', () => {
    const { entry } = logWith({ wrapped: new Error('returned') }, { serializers })

    expect(entry.wrapped).toMatchObject({ original: { type: 'Error', message: 'returned' } })
  })

  it('keeps the Errors held by an error-like root err, which the sanitizer reads by shape', () => {
    const { service, lines } = createPipeline()

    service.errorStructured(
      'KEY',
      {
        name: 'Wrapped',
        message: 'wrap',
        stack: 's',
        cause: new Error('real cause')
      } as unknown as Error,
      'u1',
      {}
    )

    expect(JSON.parse(lines[0] ?? '{}').err.cause).toMatchObject({
      name: 'Error',
      message: 'real cause'
    })
  })
})
