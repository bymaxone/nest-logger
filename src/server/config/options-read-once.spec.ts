/**
 * Pins that every option the host supplies is read once on the way to the module: the value the
 * validator accepts is the value the defaults are made from, so a getter that answers differently on
 * a second read cannot pass validation and then change.
 *
 * Layer: server/config, tests. Pure.
 */
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import { BymaxLoggerModule } from '../logger.module'
import { resolveOptions } from './resolve-options'

/** An object whose every key is counted when it is read through it. */
function counted<T extends object>(target: T, reads: Map<string, number>, path: string): T {
  return new Proxy(target, {
    get(inner, key, receiver): unknown {
      const value: unknown = Reflect.get(inner, key, receiver)
      if (typeof key === 'string') {
        const name = `${path}.${key}`
        reads.set(name, (reads.get(name) ?? 0) + 1)
        const group = typeof value === 'object' && value !== null && !Array.isArray(value)
        if (group && !(value instanceof RegExp)) return counted(value, reads, name)
      }
      return value
    }
  })
}

const options = (): Record<string, unknown> => ({
  service: { name: 'api', version: '1.0.0', environment: 'test' },
  level: 'info',
  redactPaths: ['secret'],
  http: { isEnabled: true, excludePaths: [/^\/health$/] },
  otel: { shouldAutoInjectTraceContext: false },
  shutdown: { timeoutMs: 5000 },
  destinationQueue: { maxBytes: 1024 }
})

/** The keys read more than once, with their counts. */
function repeated(reads: Map<string, number>): string[] {
  return [...reads].filter(([, count]) => count > 1).map(([name, count]) => `${name} x${count}`)
}

describe('the options of the module are read once', () => {
  it('by resolveOptions, which forRoot and the factory of forRootAsync call', () => {
    const reads = new Map<string, number>()

    resolveOptions(counted(options(), reads, 'options') as never)

    expect(reads.size).toBeGreaterThan(5)
    expect(repeated(reads)).toEqual([])
  })

  it('in the factory of forRootAsync', () => {
    const reads = new Map<string, number>()
    const module = BymaxLoggerModule.forRootAsync({ useFactory: () => ({}) } as never)
    const provider = (module.providers ?? []).find(
      (candidate) =>
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === LOGGER_OPTIONS_TOKEN
    ) as { useFactory: (raw: unknown) => unknown }

    provider.useFactory(counted(options(), reads, 'options'))

    expect(reads.size).toBeGreaterThan(5)
    expect(repeated(reads)).toEqual([])
  })

  it('so a getter that changes its answer cannot pass validation and then change', () => {
    let reads = 0
    const given = {
      service: { name: 'api', version: '1.0.0' },
      get level(): string {
        reads += 1
        return reads === 1 ? 'info' : 'loud'
      }
    }

    const module = BymaxLoggerModule.forRoot(given as never)
    const provider = (module.providers ?? []).find(
      (candidate) =>
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === LOGGER_OPTIONS_TOKEN
    ) as { useValue: { level: string } }

    expect(provider.useValue.level).toBe('info')
  })
})
