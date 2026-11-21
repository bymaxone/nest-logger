/**
 * Pins that no read of the options of the module surfaces the error of the host: the options are
 * wrapped in a Proxy whose Nth trap throws, for each N that one call to `forRoot` or to the factory
 * of `forRootAsync` reaches, and every N ends in the library's refusal, with the host's error as its
 * cause, or in a success, and never in the raw error of the host.
 *
 * Layer: server/config, tests. Pure.
 */
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import { BymaxLoggerModule } from '../logger.module'

class HostError extends Error {}

/*
 * A member of a destination that throws when it is read is contained by the registry at its own
 * stage, and the validator reads it the same way, so such a run ends in a success. A RegExp stays
 * unwrapped: a Proxy around one is not a RegExp, and the validator refuses it for that.
 */

const TRAPS = [
  'get',
  'has',
  'ownKeys',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'set',
  'defineProperty',
  'deleteProperty',
  'isExtensible',
  'preventExtensions',
  'setPrototypeOf'
] as const

/** The options of a module with every group the validator and the defaults read. */
function options(): Record<string, unknown> {
  return {
    service: { name: 'api', version: '1.0.0', environment: 'test' },
    redactPaths: ['secret'],
    destinations: [{ name: 'sink', write: () => undefined }],
    http: { isEnabled: true, excludePaths: [/^\/health$/], secretPathSegments: [/^token$/] },
    otel: { shouldAutoInjectTraceContext: false },
    shutdown: { timeoutMs: 5000, drainTimeoutMs: 1000 },
    destinationQueue: { maxBytes: 1024 },
    serializers: { custom: (value: unknown) => value },
    errorOwnFieldNames: ['code']
  }
}

/** What one run counts: the operations reached and whether the Nth was made to throw. */
interface Run {
  operations: number
  reached: boolean
}

/** A wrapper that makes the `n`th operation on the value, or on anything read through it, throw. */
function wrapper(n: number, run: Run): <T extends object>(target: T) => T {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(
      target,
      Object.fromEntries(
        TRAPS.map((trap) => [
          trap,
          (inner: object, ...args: unknown[]): unknown => {
            run.operations += 1
            if (run.operations === n) {
              run.reached = true
              throw new HostError(`trap ${trap}`)
            }
            const result: unknown = (Reflect[trap] as (...a: unknown[]) => unknown)(inner, ...args)
            const wrapped =
              typeof result === 'object' && result !== null && !(result instanceof RegExp)
            return trap === 'get' && wrapped ? wrap(result) : result
          }
        ])
      )
    )
  return wrap
}

/** Run `call` with the Nth operation on the options throwing, for every N, until none is reached. */
function sweep(
  call: (wrapped: Record<string, unknown>) => void,
  make: () => Record<string, unknown> = options
): {
  runs: number
  raw: string[]
  withoutCause: string[]
} {
  const raw: string[] = []
  const withoutCause: string[] = []
  let runs = 0
  for (let n = 1; n < 1_000; n += 1) {
    const run: Run = { operations: 0, reached: false }
    runs += 1
    try {
      call(wrapper(n, run)(make()))
    } catch (error) {
      if (error instanceof HostError) raw.push(`N=${String(n)}`)
      else if (!((error as Error).cause instanceof HostError) && run.reached) {
        withoutCause.push(`N=${String(n)}: ${(error as Error).message}`)
      }
    }
    if (!run.reached) break
  }
  return { runs, raw, withoutCause }
}

describe('the options of the module read under a host that throws on the Nth operation', () => {
  it('never surfaces the raw error of the host from forRoot', () => {
    const result = sweep((wrapped) => {
      BymaxLoggerModule.forRoot(wrapped as never)
    })

    expect(result.runs).toBeGreaterThan(20)
    expect(result.raw).toEqual([])
    expect(result.withoutCause).toEqual([])
  })

  it('refuses with a message of the library and the error of the host as its cause', () => {
    let caught: unknown
    try {
      BymaxLoggerModule.forRoot(
        new Proxy(options(), {
          get(): never {
            throw new HostError('host getter')
          }
        }) as never
      )
    } catch (error) {
      caught = error
    }

    expect((caught as Error).message).toBe('[BymaxLoggerModule] options could not be read')
    expect((caught as Error).cause).toBeInstanceOf(HostError)
  })

  it('keeps the message of a refusal about a value the host gave', () => {
    expect(() =>
      BymaxLoggerModule.forRoot({
        service: { name: 'api', version: '1.0.0' },
        level: 'loud'
      } as never)
    ).toThrow('[BymaxLoggerModule] options.level')
  })

  it('never surfaces the raw error of the host from the factory of forRootAsync', () => {
    const module = BymaxLoggerModule.forRootAsync({ useFactory: () => ({}) } as never)
    const provider = (module.providers ?? []).find(
      (candidate) =>
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === LOGGER_OPTIONS_TOKEN
    ) as { useFactory: (raw: unknown) => unknown }

    const result = sweep((wrapped) => {
      provider.useFactory(wrapped)
    })

    expect(result.runs).toBeGreaterThan(20)
    expect(result.raw).toEqual([])
    expect(result.withoutCause).toEqual([])
  })

  it('never surfaces the raw error of the host from the registration of forRootAsync', () => {
    const result = sweep(
      (wrapped) => {
        BymaxLoggerModule.forRootAsync(wrapped as never)
      },
      () => ({ useFactory: () => options(), imports: [], inject: [], extraKey: 1 })
    )

    expect(result.runs).toBeGreaterThan(5)
    expect(result.raw).toEqual([])
    expect(result.withoutCause).toEqual([])
  })
})
