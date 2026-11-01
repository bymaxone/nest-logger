/**
 * Pins what an `Error` that is NOT at a serialized root key looks like in the entry: the same node
 * the root `err` serializer produces, with its cause chain, censored by name. Driven through the
 * real Pino pipeline, so the assertions are on the line a destination receives.
 *
 * Layer: server, tests. Kept apart from the factory's spec, which is already past the size limit.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

/** A logger over the real factory whose destination captures each entry, parsed. */
function createPipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  service: PinoLoggerService
  entries(): Record<string, unknown>[]
  lines(): string[]
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino, resolveNameRedactor(options)),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    lines: () => lines
  }
}

/** Logs `metadata` beside a healthy root error and returns the entry. */
function logWith(
  metadata: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): { entry: Record<string, unknown>; line: string } {
  const { service, entries, lines } = createPipeline(extra)
  service.errorStructured('KEY', new Error('root'), 'u1', metadata)
  return { entry: entries()[0] ?? {}, line: lines()[0] ?? '' }
}

class PayError extends Error {
  readonly code = 'E_PAY'
  readonly password = 'own-secret'
  readonly detail = { token: 'detail-secret' }
  constructor(message: string) {
    super(message)
    this.name = 'PayError'
  }
}

describe('an Error outside a serialized root key', () => {
  it.each([
    [
      'a metadata key',
      (e: Error) => ({ inner: e }),
      (entry: Record<string, unknown>) => entry['inner']
    ],
    [
      'an array inside a nested object',
      (e: Error) => ({ a: { b: [e] } }),
      (entry: Record<string, unknown>) => (entry['a'] as { b: unknown[] }).b[0]
    ],
    [
      'an own field of another Error',
      (e: Error) => ({ inner: Object.assign(new Error('outer'), { wrapped: e }) }),
      (entry: Record<string, unknown>) => (entry['inner'] as { wrapped: unknown }).wrapped
    ]
  ])('is logged as the root err node when it sits in %s', (_label, wrap, pick) => {
    /*
     * `JSON.stringify` writes `{}` for an Error, because its message and stack are not
     * enumerable, so the entry used to say nothing about it. The node carries type, message
     * and stack like the root `err`.
     */
    const { entry } = logWith(wrap(new Error('nested boom')))

    expect(pick(entry)).toMatchObject({ type: 'Error', message: 'nested boom' })
    expect(pick(entry)).toHaveProperty('stack', expect.stringContaining('nested boom'))
  })

  it('keeps the cause chain and AggregateError.errors, as the root err does', () => {
    const { entry } = logWith({
      chain: new Error('top', { cause: new Error('root cause') }),
      many: new AggregateError([new Error('first'), new Error('second')], 'agg')
    })

    expect(entry['chain']).toMatchObject({ message: 'top', cause: { message: 'root cause' } })
    expect(entry['many']).toMatchObject({
      type: 'AggregateError',
      errors: [{ message: 'first' }, { message: 'second' }]
    })
  })

  it('carries a subclass own fields beside type, message and stack', () => {
    const { entry } = logWith({ inner: new PayError('pay failed') })

    expect(entry['inner']).toMatchObject({
      type: 'PayError',
      message: 'pay failed',
      code: 'E_PAY'
    })
  })

  it('censors an own field of the nested Error, of its detail and of its cause, by name', () => {
    /*
     * The node is walked again, so a secret an Error carries is censored like any other
     * field: on the Error itself, below it, and on a link of its cause chain.
     */
    const withSecretCause = new Error('top', {
      cause: Object.assign(new Error('link'), { accessToken: 'cause-secret' })
    })
    const { entry, line } = logWith({ inner: new PayError('pay failed'), chain: withSecretCause })

    expect(entry['inner']).toMatchObject({
      password: '[REDACTED]',
      detail: { token: '[REDACTED]' }
    })
    expect(entry['chain']).toMatchObject({ cause: { accessToken: '[REDACTED]' } })
    expect(line).not.toContain('own-secret')
    expect(line).not.toContain('detail-secret')
    expect(line).not.toContain('cause-secret')
  })

  it('ends an Error that reaches itself at the cycle marker', () => {
    const cyclic = Object.assign(new Error('cyc'), {}) as Error & { self?: unknown }
    cyclic.self = cyclic

    const { entry } = logWith({ inner: cyclic })

    expect(entry['inner']).toMatchObject({ message: 'cyc', self: '[Circular]' })
  })

  it('logs an Error that is shared by two keys in full under both, because it is not a cycle', () => {
    /*
     * The Error is on the cycle-guard path only while its own node is walked. Left there, the
     * second key that holds the same instance would be reported as a cycle it is not.
     */
    const shared = new Error('shared boom')

    const { entry } = logWith({ first: shared, second: shared })

    expect(entry['first']).toMatchObject({ type: 'Error', message: 'shared boom' })
    expect(entry['second']).toMatchObject({ type: 'Error', message: 'shared boom' })
  })

  it('truncates a cause chain past the same depth the root err does', () => {
    /*
     * The node is built by the same sanitizer as the root `err`, so its cause limit is that
     * sanitizer's: three levels, then a marker. Pinned here so a change to either is seen.
     */
    let chain = new Error('d0')
    for (let level = 1; level <= 8; level++) {
      chain = new Error(`d${level}`, { cause: chain })
    }

    const { entry } = logWith({ inner: chain })

    const level = (node: unknown, depth: number): unknown =>
      depth === 0 ? node : level((node as { cause: unknown }).cause, depth - 1)
    expect(level(entry['inner'], 3)).toMatchObject({ message: 'd5' })
    expect(level(entry['inner'], 4)).toMatchObject({
      _truncated: true,
      _reason: 'cause-depth-exceeded'
    })
  })

  it('drops an Error below the walk depth ceiling and still emits the entry', () => {
    // The walk's own ceiling is unchanged: a container past it is dropped, an Error included.
    let nested: Record<string, unknown> = { leaf: new Error('too deep') }
    for (let level = 0; level < 105; level++) {
      nested = { next: nested }
    }

    const { entry, line } = logWith({ deep: nested })

    expect(entry).toMatchObject({ logKey: 'KEY' })
    expect(line).not.toContain('too deep')
  })

  it('gives a hostile Error the same node shape as a healthy one', () => {
    const hostile = Object.defineProperty(new Error('boom'), 'message', {
      get: () => {
        throw new Error('message exploded')
      }
    })

    const { entry } = logWith({ inner: hostile })

    expect(entry['inner']).toMatchObject({ type: 'SanitizeFailed' })
    expect(entry['inner']).toHaveProperty('message')
  })
})

describe('an Error at a root key that has a serializer', () => {
  /** A serializer that can tell whether it received an `Error` instance. */
  const serializers = {
    error: (input: unknown): unknown => ({ isInstance: input instanceof Error })
  }

  it('reaches the serializer as an Error instance', () => {
    /*
     * Serializers run after the redactor and a host's may rely on `instanceof Error`, so the
     * instance survives at the keys they are registered for, not only at `err`.
     */
    const { entry } = logWith({ error: new Error('custom slot') }, { serializers })

    expect(entry['error']).toStrictEqual({ isInstance: true })
  })

  it('still becomes a node anywhere else', () => {
    const { entry } = logWith({ other: new Error('elsewhere') }, { serializers })

    expect(entry['other']).toMatchObject({ type: 'Error', message: 'elsewhere' })
  })

  it('reaches the serializer as an Error instance through child() bindings', () => {
    const { service, entries } = createPipeline({ serializers })

    service.child({ error: new Error('bound') }).log('hello')

    expect(entries()[0]?.['error']).toStrictEqual({ isInstance: true })
  })

  it('turns an Error in child() bindings at a key without a serializer into the node', () => {
    const { service, entries } = createPipeline({ serializers })

    service.child({ cause: new Error('bound') }).log('hello')

    expect(entries()[0]?.['cause']).toMatchObject({ type: 'Error', message: 'bound' })
  })
})
