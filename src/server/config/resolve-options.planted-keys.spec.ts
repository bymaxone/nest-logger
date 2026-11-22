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
import { runInNewContext } from 'node:vm'

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
const PLANTED: unknown[] = [true, false, 'S1', 'silent', 'flat', ['password'], {}, 1, () => 'S1']

const SERVICE = { name: 'app', version: '1.0.0' }

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
function planted<T>(key: string, value: unknown, read: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    return read()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('a key planted on Object.prototype', () => {
  const baseline = linesFor({ service: SERVICE, redactPaths: ['custom'] })

  /**
   * Given the record of ten secrets written without a planted key, and the same with one planted
   * When the options are the same
   * Then the lines are the same, so no secret that was hidden is written
   */
  it.each(KEYS)('changes nothing when %s is planted', (key) => {
    for (const value of PLANTED) {
      const lines = planted(key, value, () =>
        linesFor({ service: SERVICE, redactPaths: ['custom'] })
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
    const foreign = runInNewContext(
      '({ service: { name: "app", version: "1.0.0" }, redactCensor: "OWN" })'
    ) as BymaxLoggerModuleOptions
    const root = runInNewContext('Object.prototype') as object
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
   * Then the getter counts, as it did, and a planted key beside it does not
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
    for (const name of names) {
      const lines = planted(name, true, () =>
        linesFor({ service: SERVICE, redactPaths: ['custom'] })
      )

      expect({ name, lines }).toEqual({ name, lines: baseline })
    }
  })

  /**
   * Given a root whose own `constructor` and `isPrototypeOf` were overwritten and whose `hasOwnProperty` was deleted, in this
   * realm and in another, with the switch that turns default redaction off planted beside them
   * When options are resolved
   * Then the planted switch is skipped all the same: the check reads no property of the root
   */
  it.each([
    ['this realm', (): object => Object.prototype],
    ['another realm', (): object => runInNewContext('Object.prototype') as object]
  ])('skips a key planted on a root whose properties were overwritten, in %s', (_realm, root) => {
    const object = root()
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
      const own = runInNewContext(
        '({ service: { name: "app", version: "1.0.0" } })'
      ) as BymaxLoggerModuleOptions
      const here = { service: SERVICE } as BymaxLoggerModuleOptions

      expect(resolveOptions(here).shouldDisableDefaultRedact).toBe(false)
      if (object !== Object.prototype)
        expect(resolveOptions(own).shouldDisableDefaultRedact).toBe(false)
    } finally {
      Reflect.deleteProperty(object, 'shouldDisableDefaultRedact')
      for (const [key, before] of saved) {
        if (before) Object.defineProperty(object, key, before)
      }
      if (owned) Object.defineProperty(object, 'hasOwnProperty', owned)
    }
  })

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
})
