/**
 * Verifies that a key planted on `Object.prototype` is no option the consumer set: the options read
 * the same with it as without it, so default redaction stays on, the censor stays the censor and
 * every other option keeps its default. A key that only a realm root holds is skipped; one a class
 * prototype defines (a getter) still counts, and so does one an object has itself.
 *
 * Layer: server/config, tests. Driven through the options and the real factory.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'

import { resolveOptions } from './resolve-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

/** Every option of the module and of its groups. */
const KEYS = [
  'service',
  'level',
  'isGlobal',
  'shouldUseAsNestLogger',
  'redactPaths',
  'redactStrategy',
  'resourceFormat',
  'eventNameField',
  'errorFormat',
  'redactCensor',
  'shouldDisableDefaultRedact',
  'destinations',
  'http',
  'otel',
  'maxEntrySizeBytes',
  'maxStringLength',
  'destinationHookTimeoutMs',
  'shutdown',
  'destinationQueue',
  'errorOwnFields',
  'errorOwnFieldNames',
  'serializers',
  'timestamp',
  'isEnabled',
  'shouldCaptureExceptions',
  'shouldGenerateRequestId',
  'excludePaths',
  'secretPathSegments',
  'tenantIdHeader',
  'tenantIdResolver',
  'shouldAutoInjectTraceContext',
  'fieldFormat',
  'traceIdField',
  'spanIdField',
  'traceFlagsField',
  'timeoutMs',
  'drainTimeoutMs',
  'maxBytes',
  'environment',
  'name',
  'version',
  // What pino reads from the options this library hands it, and from its own `redact` group.
  'enabled',
  'safe',
  'messageKey',
  'errorKey',
  'nestedKey',
  'base',
  'formatters',
  'hooks',
  'mixin',
  'mixinMergeStrategy',
  'redact',
  'transport',
  'customLevels',
  'useOnlyCustomLevels',
  'depthLimit',
  'edgeLimit',
  'levelVal',
  'write',
  'id',
  'hasOwnProperty',
  'streamLevels',
  'lastLevel',
  'lastTime',
  'lastMsg',
  'lastObj',
  'lastLogger',
  'minLevel',
  'dedupe',
  'crlf',
  'msgPrefix',
  'writable',
  '_writableState',
  'prettyPrint',
  'onChild',
  'levelKey',
  'paths',
  'censor',
  'remove'
]

/** What a planted key may hold: a value of the type that passes the check of the option, and one that does not. */
const PLANTED: unknown[] = [
  true,
  false,
  'S1',
  'silent',
  'flat',
  ['password'],
  {},
  1,
  100,
  Number.NaN,
  () => 'S1'
]

const SERVICE = { name: 'app', version: '1.0.0' }

/**
 * The names a plant under which Pino itself does not survive, whatever the options hold. Pino sets its
 * levels with a `for...in` over its own table of levels and assigns each key it finds to the instance, so a
 * key planted enumerably under `level`, `levels`, `msgPrefix` or `levelVal` throws, and `hasOwnProperty`
 * is a method Pino calls on its bindings. It throws when the logger is built or at the first call
 * (`THROWS_AT`): no option can shadow that. It is a limit of Pino, stated in the changelog and the
 * README, and a row below holds it.
 */
const PINO_ITERATED = ['level', 'levels', 'msgPrefix', 'levelVal', 'hasOwnProperty']

/** Where each throws: while the logger is built, or at the first call of the Nest-style methods. */
const THROWS_AT = new Map<string, 'build' | 'call'>([
  ['level', 'build'],
  ['levels', 'call'],
  ['msgPrefix', 'build'],
  ['levelVal', 'build'],
  ['hasOwnProperty', 'build']
])

/** The names that change nothing when the plant is not enumerable; for the others a plant replaces a method that Pino or Node calls. */
const QUIET_WHEN_HIDDEN = ['level', 'levels', 'msgPrefix', 'levelVal']

/** The lines written for a record that carries ten secrets, with the time left out. */
function linesFor(given: BymaxLoggerModuleOptions): string[] {
  const lines: string[] = []
  const options = resolveOptions(given)
  const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
  const log = new PinoLoggerService(
    buildPinoInstance(options, new LogContextService(), [sink as never], new DestinationHealth())
  )
  log.warn({
    event: 'E',
    password: 'S1',
    authorization: 'S2',
    token: 'S3',
    custom: 'S4',
    meta: { apiKey: 'S5', nested: { secret: 'S7' } },
    headers: { cookie: 'S8' }
  } as never)
  log.error({ message: 'S9', stack: 'Error: S9\n    at f (/a.js:1:1)' } as never, 'S10')
  return lines.map((line) => line.replace(/"time":"[^"]*"/, '"time":"T"'))
}

/** Plant `value` under `key` on `Object.prototype` while `read` runs. */
function planted<T>(key: string, value: unknown, read: () => T, enumerable = true): T {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, key)
  // Plain assignment, as a pollution does it: the key is enumerable, so a `for...in` sees it. One
  // that is not enumerable is a plant made with `defineProperty`.
  if (enumerable) Reflect.set(Object.prototype, key, value)
  else Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    return read()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
    // A name the root has itself (`hasOwnProperty`) is put back as it was.
    if (before) Object.defineProperty(Object.prototype, key, before)
  }
}

describe('a key planted on Object.prototype', () => {
  const baseline = linesFor({ service: SERVICE, redactPaths: ['custom'] })

  /**
   * Given the record of ten secrets written without a planted key, and the same with one planted
   * When the options are the same
   * Then the lines are the same, so no secret that was hidden is written
   */
  it.each([
    ...KEYS.filter((key) => !PINO_ITERATED.includes(key)).map((key) => [key, true] as const),
    ...KEYS.map((key) => [key, false] as const).filter(
      ([key]) => !PINO_ITERATED.includes(key) || QUIET_WHEN_HIDDEN.includes(key)
    )
  ])('changes nothing when %s is planted, enumerable: %s', (key, enumerable) => {
    for (const value of PLANTED) {
      const lines = planted(
        key,
        value,
        () => linesFor({ service: SERVICE, redactPaths: ['custom'] }),
        enumerable
      )

      expect(lines).toEqual(baseline)
    }
  })

  /**
   * Given the two plants that weakened redaction: the switch that turns the default paths off and a censor
   * that is one of the secrets
   * When options with neither are resolved
   * Then the defaults stand and none of the ten secrets is written
   */
  it('keeps default redaction on and the censor the default', () => {
    const resolved = planted('shouldDisableDefaultRedact', true, () =>
      resolveOptions({ service: SERVICE })
    )
    const censor = planted('redactCensor', 'S1', () => resolveOptions({ service: SERVICE }))
    const lines = planted('shouldDisableDefaultRedact', true, () =>
      linesFor({ service: SERVICE })
    ).join('')

    expect(resolved.shouldDisableDefaultRedact).toBe(false)
    expect(censor.redactCensor).toBe('[REDACTED]')
    for (const secret of ['S1', 'S2', 'S3', 'S5', 'S7', 'S8'])
      expect(lines).not.toMatch(new RegExp(`${secret}(?!\\d)`))
  })

  /**
   * Given options an object from another realm holds, with the `Object.prototype` of that realm planted
   * When they are resolved
   * Then the planted key is skipped as it is for this realm, and the key the object has itself counts
   */
  it('skips a key planted on the Object.prototype of another realm, and keeps one the object owns', () => {
    // One context for both, so the root is the prototype of the options.
    const context = createContext({})
    const foreign = runInContext(
      '({ service: { name: "app", version: "1.0.0" }, redactCensor: "OWN" })',
      context
    ) as BymaxLoggerModuleOptions
    const root = Object.getPrototypeOf(foreign) as object
    expect(root).not.toBe(Object.prototype)
    Object.defineProperty(root, 'shouldDisableDefaultRedact', {
      value: true,
      configurable: true,
      writable: true
    })
    try {
      const resolved = resolveOptions(foreign)

      expect(resolved.shouldDisableDefaultRedact).toBe(false)
      expect(resolved.redactCensor).toBe('OWN')
    } finally {
      Reflect.deleteProperty(root, 'shouldDisableDefaultRedact')
    }
  })

  /**
   * Given a class that defines an option as a getter on its prototype
   * When an instance is resolved
   * Then the getter counts, and a planted key beside it does not
   */
  it('still reads a getter a class prototype defines', () => {
    class Options {
      readonly service = SERVICE
      get redactCensor(): string {
        return 'GETTER'
      }
    }

    const resolved = planted('shouldDisableDefaultRedact', true, () =>
      resolveOptions(new Options() as BymaxLoggerModuleOptions)
    )

    expect(resolved.redactCensor).toBe('GETTER')
    expect(resolved.shouldDisableDefaultRedact).toBe(false)
  })

  /**
   * Given every name the installed Pino reads off the options it is handed, found in its own source: the
   * names it takes out of them in one destructuring and those its argument normalizer tests
   * When each is planted on `Object.prototype`
   * Then the lines are the baseline's, so a Pino that starts reading another name fails here
   */
  it('changes nothing for any name the installed Pino reads off its options', () => {
    const lib = createRequire(__filename)
      .resolve('pino')
      .replace(/pino\.js$/, '')
    const main = readFileSync(`${lib}pino.js`, 'utf8')
    const tools = readFileSync(`${lib}lib/tools.js`, 'utf8')
    const taken = /const \{([^}]+)\} = opts\b/.exec(main)?.[1] ?? ''
    const names = new Set([
      ...taken.split(',').map((name) => name.trim()),
      ...[...tools.matchAll(/\bopts\.(\w+)/g)].map((match) => match[1] ?? '')
    ])
    names.delete('')

    expect(names.size).toBeGreaterThan(20)
    expect(names).toContain('transport')
    for (const name of [...names].filter((one) => !PINO_ITERATED.includes(one))) {
      const lines = planted(name, true, () =>
        linesFor({ service: SERVICE, redactPaths: ['custom'] })
      )

      expect({ name, lines }).toEqual({ name, lines: baseline })
    }
  })

  /**
   * Given a key planted enumerably under the name of a property of Pino's own instances, and the same key
   * planted without being enumerable
   * When the options are resolved and the logger built
   * Then the first makes Pino throw, while it is built or at the first call, which no option can prevent, and
   * the second changes nothing
   */
  it.each(PINO_ITERATED)('is a limit of Pino when %s is planted enumerably', (name) => {
    const build = (): PinoLoggerService =>
      new PinoLoggerService(
        buildPinoInstance(
          resolveOptions({ service: SERVICE }),
          new LogContextService(),
          [{ name: 'sink', write: () => undefined } as never],
          new DestinationHealth()
        )
      )
    if (THROWS_AT.get(name) === 'build') {
      expect(() => planted(name, 'X', build)).toThrow()
    } else {
      expect(() => planted(name, 'X', () => build().warn({ event: 'E' } as never))).toThrow()
    }

    if (QUIET_WHEN_HIDDEN.includes(name)) {
      expect(
        planted(name, 'X', () => linesFor({ service: SERVICE, redactPaths: ['custom'] }), false)
      ).toEqual(baseline)
    }
  })

  /**
   * Given a root whose own `constructor` and `isPrototypeOf` were overwritten and whose `hasOwnProperty` was deleted, in this
   * realm and in another, with the switch that turns default redaction off planted beside them
   * When options are resolved
   * Then the planted switch is skipped all the same: the check reads no property of the root
   */
  it.each([
    ['this realm', false],
    ['another realm', true]
  ])(
    'skips a key planted on a root whose properties were overwritten, in %s',
    (_realm, foreign) => {
      // For another realm the options and the root come from one context, so the root is their prototype.
      const options = (
        foreign
          ? runInContext('({ service: { name: "app", version: "1.0.0" } })', createContext({}))
          : { service: SERVICE }
      ) as BymaxLoggerModuleOptions
      const object = foreign ? (Object.getPrototypeOf(options) as object) : Object.prototype
      expect(object === Object.prototype).toBe(!foreign)
      const plant = (key: string, value: unknown): PropertyDescriptor | undefined => {
        const before = Object.getOwnPropertyDescriptor(object, key)
        Object.defineProperty(object, key, { value, configurable: true, writable: true })
        return before
      }
      const saved = ['constructor', 'isPrototypeOf'].map((key) => [key, plant(key, 'X')] as const)
      const owned = Object.getOwnPropertyDescriptor(object, 'hasOwnProperty')
      Reflect.deleteProperty(object, 'hasOwnProperty')
      plant('shouldDisableDefaultRedact', true)
      try {
        expect(resolveOptions(options).shouldDisableDefaultRedact).toBe(false)
      } finally {
        Reflect.deleteProperty(object, 'shouldDisableDefaultRedact')
        for (const [key, before] of saved) {
          if (before) Object.defineProperty(object, key, before)
        }
        if (owned) Object.defineProperty(object, 'hasOwnProperty', owned)
      }
    }
  )

  /**
   * Given options held by a prototype that has a prototype of its own, and options an object owns, even
   * when it owns a key named `hasOwnProperty`
   * When they are resolved
   * Then the values count; a prototype with no prototype of its own is a root and is skipped
   */
  it('keeps what a prototype with a prototype holds, and what a bare object owns', () => {
    const base = Object.create(null, {
      redactCensor: { value: 'BASE', enumerable: true }
    }) as object
    const skipped = Object.assign(Object.create(base) as object, { service: SERVICE })
    const named = Object.assign(
      Object.create({ redactCensor: 'NAMED', hasOwnProperty: () => true }),
      {
        service: SERVICE
      }
    ) as object
    const bare = Object.assign(Object.create(null) as object, {
      service: SERVICE,
      redactCensor: 'OWN',
      hasOwnProperty: () => true
    })

    expect(resolveOptions(skipped as BymaxLoggerModuleOptions).redactCensor).toBe('[REDACTED]')
    expect(resolveOptions(named as BymaxLoggerModuleOptions).redactCensor).toBe('NAMED')
    expect(resolveOptions(bare as BymaxLoggerModuleOptions).redactCensor).toBe('OWN')
  })

  /**
   * Given options a Proxy answers through its `get` trap, with a key of the same name planted on
   * `Object.prototype`
   * When they are resolved
   * Then the answer of the trap counts
   */
  it('keeps what a Proxy answers for a key that is also planted', () => {
    const answers = Object.assign(Object.create(null) as object, {
      service: SERVICE,
      redactPaths: ['customSecret'],
      redactCensor: 'PROXY'
    })
    const proxy = new Proxy(
      {},
      { get: (_target, key) => Reflect.get(answers, key) }
    ) as BymaxLoggerModuleOptions

    const resolved = planted('redactPaths', [], () => resolveOptions(proxy))

    expect(resolved.redactPaths).toEqual(['customSecret'])
    expect(resolved.redactCensor).toBe('PROXY')
  })

  /**
   * Given plain options and an accessor planted on `Object.prototype` under the name of an option
   * When they are resolved
   * Then the accessor is not called and the default applies
   */
  it('does not call an accessor planted under the name of an option', () => {
    let called = false
    Object.defineProperty(Object.prototype, 'redactCensor', {
      get: () => {
        called = true
        return 'ROOT'
      },
      configurable: true
    })
    try {
      expect(resolveOptions({ service: SERVICE }).redactCensor).toBe('[REDACTED]')
      expect(called).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'redactCensor')
    }
  })

  /**
   * Given options a Proxy answers through its `get` trap, with an accessor planted on `Object.prototype`
   * under the name the trap answers for
   * When they are resolved
   * Then the answer of the trap counts
   */
  it('keeps what a Proxy answers for a key under which an accessor is planted', () => {
    const proxy = new Proxy(
      { service: SERVICE },
      {
        get: (target, key, receiver) =>
          key === 'redactCensor' ? 'OWN' : Reflect.get(target, key, receiver)
      }
    ) as BymaxLoggerModuleOptions
    Object.defineProperty(Object.prototype, 'redactCensor', {
      get: () => 'ROOT',
      configurable: true
    })
    try {
      expect(resolveOptions(proxy).redactCensor).toBe('OWN')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'redactCensor')
    }
  })
})
