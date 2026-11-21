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
        if (Array.isArray(value)) return counted(value, reads, name)
        const group = typeof value === 'object' && value !== null && !(value instanceof RegExp)
        if (group && !Array.isArray(target)) return counted(value, reads, name)
      }
      return value
    }
  })
}

const options = (): Record<string, unknown> => ({
  service: { name: 'api', version: '1.0.0', environment: 'test' },
  level: 'info',
  redactPaths: ['secret'],
  errorOwnFieldNames: ['code'],
  destinations: [{ name: 'sink', write: () => undefined }],
  serializers: { custom: (value: unknown) => value },
  http: { isEnabled: true, excludePaths: [/^\/health$/], secretPathSegments: [/^token$/] },
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

  it('by the whole of forRoot, which hands the module builder the copy', () => {
    const reads = new Map<string, number>()

    BymaxLoggerModule.forRoot(counted(options(), reads, 'options') as never)

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

/** A list whose first element answers `first` the first time it is read and `second` after that. */
function flipping<T>(first: T, second: T): T[] {
  let reads = 0
  return new Proxy([first], {
    get(inner, key, receiver): unknown {
      if (key === '0') {
        reads += 1
        return reads === 1 ? first : second
      }
      return Reflect.get(inner, key, receiver)
    }
  })
}

describe('a list or a table that answers differently on a second read', () => {
  const sink = (name: string): { name: string; write: () => void } => ({
    name,
    write: () => undefined
  })
  const cases: ReadonlyArray<
    readonly [string, (given: Record<string, unknown>) => void, (r: any) => unknown, unknown]
  > = [
    [
      'redactPaths',
      (g) => (g['redactPaths'] = flipping('topSecret', 'x')),
      (r) => r.redactPaths,
      ['topSecret']
    ],
    [
      'errorOwnFieldNames',
      (g) => (g['errorOwnFieldNames'] = flipping('code', 'x')),
      (r) => r.errorOwnFieldNames,
      ['code']
    ],
    [
      'destinations',
      (g) => (g['destinations'] = flipping(sink('first'), sink('second'))),
      (r) => r.destinations.map((d: { name: string }) => d.name),
      ['first']
    ],
    [
      'http.excludePaths',
      (g) => (g['http'] = { excludePaths: flipping(/^a$/, /^b$/) }),
      (r) => r.http.excludePaths.map(String),
      ['/^a$/']
    ],
    [
      'http.secretPathSegments',
      (g) => (g['http'] = { secretPathSegments: flipping(/^a$/, /^b$/) }),
      (r) => r.http.secretPathSegments.map(String),
      ['/^a$/']
    ]
  ]

  it.each(cases)('%s is the list that passed validation', (_name, set, read, expected) => {
    const given: Record<string, unknown> = { service: { name: 'api', version: '1.0.0' } }
    set(given)

    expect(read(resolveOptions(given as never))).toEqual(expected)
  })

  it('serializers is the table that passed validation', () => {
    let reads = 0
    const first = (value: unknown): unknown => value
    const second = (): unknown => 'second'
    const serializers = {
      get custom(): unknown {
        reads += 1
        return reads === 1 ? first : second
      }
    }

    const resolved = resolveOptions({
      service: { name: 'api', version: '1.0.0' },
      serializers
    } as never)

    expect(resolved.serializers['custom']).toBe(first)
  })
})

describe('a value that is not a list where a list belongs', () => {
  it.each(['redactPaths', 'errorOwnFieldNames', 'destinations'])(
    '%s is refused by the validator and not read as a list',
    (name) => {
      const given = { service: { name: 'api', version: '1.0.0' }, [name]: 'abc' }

      expect(() => resolveOptions(given as never)).toThrow(`[BymaxLoggerModule] options.${name}`)
    }
  )

  it.each(['excludePaths', 'secretPathSegments'])('http.%s is refused too', (name) => {
    const given = { service: { name: 'api', version: '1.0.0' }, http: { [name]: 'abc' } }

    expect(() => resolveOptions(given as never)).toThrow(`[BymaxLoggerModule] options.http.${name}`)
  })
})
