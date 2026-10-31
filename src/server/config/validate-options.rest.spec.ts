/**
 * Validation of the customization hooks, the destinations, the `http` and `otel` groups
 * and the remaining scalars by `validateOptions`.
 *
 * Layer: server/config, tests. Each of these is read as a function, an array or a
 * string by code that runs later, per entry or per request, where a wrong type fails
 * far from its cause or not at all; the validator is where a config typo surfaces at
 * bootstrap with the name of the option.
 */
import { runInNewContext } from 'node:vm'

import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { validateOptions } from './validate-options'

const base: BymaxLoggerModuleOptions = { service: { name: 'app', version: '1.0.0' } }

/** Build options with one extra key, bypassing the compile-time types as untyped JS would. */
const withOption = (key: string, value: unknown): BymaxLoggerModuleOptions =>
  ({ ...base, [key]: value }) as BymaxLoggerModuleOptions

const goodDestination = { name: 'sink', write: (): void => {} }

describe('validateOptions: scalars and customization hooks', () => {
  it(/*
   * Every value below is a valid configuration. A tightening of the validator must
   * not reject what the documented types accept.
   */
  'accepts a fully specified valid configuration', () => {
    expect(() =>
      validateOptions({
        ...base,
        isGlobal: false,
        shouldDisableDefaultRedact: false,
        redactCensor: '***',
        redactPaths: ['user.ssn', 'req.body.card.*'],
        timestamp: () => '2026-01-01T00:00:00.000Z',
        serializers: { order: (o: unknown) => o },
        maxEntrySizeBytes: 1024,
        destinations: [
          goodDestination,
          { ...goodDestination, name: 'other', onInit: async () => {} }
        ],
        http: {
          isEnabled: true,
          shouldCaptureExceptions: false,
          shouldGenerateRequestId: true,
          excludePaths: [/^\/health$/],
          tenantIdHeader: 'x-org-id'
        },
        otel: {
          shouldAutoInjectTraceContext: false,
          fieldFormat: 'snake_case',
          traceIdField: 'trace.id',
          spanIdField: 'span.id',
          traceFlagsField: 'trace.flags'
        }
      })
    ).not.toThrow()
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1024']
  ])(
    /*
     * `NaN` and `Infinity` pass a `<= 0` comparison, so the size gate would silently
     * never trip; a string compares by coercion. All three are config mistakes.
     */
    'rejects a maxEntrySizeBytes that is %s',
    (_label, value) => {
      expect(() => validateOptions(withOption('maxEntrySizeBytes', value))).toThrow(
        /options\.maxEntrySizeBytes must be a finite number/
      )
    }
  )

  it.each([
    ['isGlobal', 'yes'],
    ['shouldDisableDefaultRedact', 'false'],
    ['redactCensor', 42],
    ['timestamp', 'now'],
    ['serializers', []],
    ['serializers', null],
    ['redactPaths', 'user.ssn'],
    ['destinations', goodDestination]
  ])(
    /*
     * Each option has one valid kind of value. A wrong kind is named by option and by
     * what was received, so the message alone locates the typo.
     */
    'rejects %s given a value of the wrong kind (%p)',
    (key, value) => {
      expect(() => validateOptions(withOption(key, value))).toThrow(
        new RegExp(`options\\.${key} must be`)
      )
    }
  )

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['null', null]
  ])(
    /*
     * A redact path is a non-empty string; anything else would be handed to fast-redact
     * at Pino construction, where the failure names no option.
     */
    'rejects a redactPaths entry that is %s',
    (_label, entry) => {
      expect(() => validateOptions(withOption('redactPaths', ['ok', entry]))).toThrow(
        /options\.redactPaths\[1\] must be a non-empty string/
      )
    }
  )

  it(/*
   * A serializer that is not a function would throw on the first entry that carries
   * its key, inside the logging path. The message names the offending key.
   */
  'rejects a serializer that is not a function and names its key', () => {
    expect(() =>
      validateOptions(withOption('serializers', { order: (o: unknown) => o, user: 'nope' }))
    ).toThrow(/options\.serializers\.user must be a function/)
  })
})

describe('validateOptions: the rejection message', () => {
  it.each([
    ['null', null, 'null'],
    ['an array', ['a'], 'an array'],
    ['an object', { a: 1 }, 'an object'],
    ['a function', () => 1, 'a function'],
    ['a string, quoted', 'secret-value', '"secret-value"'],
    ['a number', 42, '42']
  ])(
    /*
     * The message says what was received so the typo can be located, in a form that
     * never throws on an exotic value. An object, array or function is described by
     * its kind, not printed, so a rejected credential-bearing object does not end up
     * in a bootstrap log.
     */
    'describes a rejected %s',
    (_label, value, expected) => {
      expect(() => validateOptions(withOption('isGlobal', value))).toThrow(
        new RegExp(
          `options\\.isGlobal must be a boolean\\. Got: ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        )
      )
    }
  )
})

describe('validateOptions: destinations', () => {
  it.each([
    ['not an object', 'stdout'],
    ['null', null],
    ['an object without write', { name: 'x' }],
    ['an object whose write is not a function', { name: 'x', write: 'nope' }],
    ['an object without a name', { write: () => {} }],
    ['an object with an empty name', { name: '', write: () => {} }],
    ['an object with a non-function onInit', { ...goodDestination, onInit: 'later' }],
    ['an object with a non-function onShutdown', { ...goodDestination, onShutdown: true }],
    ['an object with a non-function onRegistryReady', { ...goodDestination, onRegistryReady: 1 }]
  ])(
    /*
     * The fan-out calls `write` for every entry and the registry calls the three hooks
     * by name. An entry that cannot satisfy the contract is rejected before the first
     * log line, with its index, instead of failing once per entry afterwards.
     */
    'rejects a destination that is %s',
    (_label, entry) => {
      expect(() => validateOptions(withOption('destinations', [goodDestination, entry]))).toThrow(
        /options\.destinations\[1\]/
      )
    }
  )

  it(/*
   * A destination may expose `name` through a getter that throws; the registry reads
   * it under a guard and reports 'unknown'. Validation must not turn that tolerated
   * case into a bootstrap failure.
   */
  'tolerates a destination whose name getter throws', () => {
    const hostile = {
      get name(): string {
        throw new Error('boom')
      },
      write: (): void => {}
    }
    expect(() => validateOptions(withOption('destinations', [hostile]))).not.toThrow()
  })

  it.each(['write', 'onInit', 'onShutdown', 'onRegistryReady'])(
    /*
     * The registry and the fan-out read `write` and the three hooks under a guard, so
     * a getter that throws becomes a contained destination failure at its own stage.
     * The validator must not read them unguarded and abort bootstrap before that
     * isolation can apply.
     */
    'tolerates a destination whose %s getter throws',
    (member) => {
      const hostile = { name: 'external', write: (): void => {}, onInit: undefined }
      Object.defineProperty(hostile, member, {
        get(): never {
          throw new Error('sink unavailable')
        },
        enumerable: true
      })
      expect(() => validateOptions(withOption('destinations', [hostile]))).not.toThrow()
    }
  )

  it(/*
   * An empty list is valid and means the stdout default, so it must not be rejected.
   */
  'accepts an empty destinations list', () => {
    expect(() => validateOptions(withOption('destinations', []))).not.toThrow()
  })
})

describe('validateOptions: http', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'on']
  ])(
    /*
     * The group is spread over the defaults, so a non-object either vanishes silently
     * (null) or contributes index keys (an array or a string).
     */
    'rejects http given %s',
    (_label, value) => {
      expect(() => validateOptions(withOption('http', value))).toThrow(
        /options\.http must be an object/
      )
    }
  )

  it.each(['isEnabled', 'shouldCaptureExceptions', 'shouldGenerateRequestId'])(
    /*
     * The three switches are read as booleans; `'false'` is truthy, so a string from an
     * environment variable would turn the feature ON.
     */
    'rejects a non-boolean http.%s',
    (key) => {
      expect(() => validateOptions(withOption('http', { [key]: 'false' }))).toThrow(
        new RegExp(`options\\.http\\.${key} must be a boolean`)
      )
    }
  )

  it(/*
   * Each entry is `.test()`-ed against every request path, so the list itself must be
   * an array.
   */
  'rejects http.excludePaths that is not an array', () => {
    expect(() => validateOptions(withOption('http', { excludePaths: /^\/health$/ }))).toThrow(
      /options\.http\.excludePaths must be an array of RegExp/
    )
  })

  it.each([
    ['a string', '/health'],
    ['an object that only has a test method', { test: () => true }]
  ])(
    /*
     * A string has no `test`, and an object with one is not a pattern the ReDoS
     * guidance covers. The message names the entry's index.
     */
    'rejects an http.excludePaths entry that is %s',
    (_label, entry) => {
      expect(() =>
        validateOptions(withOption('http', { excludePaths: [/^\/ok$/, entry] }))
      ).toThrow(/options\.http\.excludePaths\[1\] must be a RegExp/)
    }
  )

  it(/*
   * `readonly RegExp[]` also admits a pattern built in another realm (a `vm`
   * context, a worker, a test sandbox boundary), for which `instanceof RegExp` is
   * false although `.test()` works. Rejecting it would turn a configuration that
   * booted before into a bootstrap failure, so the check is realm-independent.
   */
  'accepts a RegExp built in another realm in http.excludePaths', () => {
    const foreign = runInNewContext('/^\\/probe$/') as RegExp
    expect(foreign instanceof RegExp).toBe(false)
    expect(() => validateOptions(withOption('http', { excludePaths: [foreign] }))).not.toThrow()
  })

  it.each([[''], [42], [null]])(
    /*
     * The header name is passed to a lookup on every request; an empty or non-string
     * name would match nothing, or throw, on each one.
     */
    'rejects http.tenantIdHeader %p',
    (value) => {
      expect(() => validateOptions(withOption('http', { tenantIdHeader: value }))).toThrow(
        /options\.http\.tenantIdHeader must be a non-empty string/
      )
    }
  )
})

describe('validateOptions: otel', () => {
  it.each([
    ['null', null],
    ['an array', []]
  ])(
    /*
     * Same reason as `http`: the group is spread over the defaults.
     */
    'rejects otel given %s',
    (_label, value) => {
      expect(() => validateOptions(withOption('otel', value))).toThrow(
        /options\.otel must be an object/
      )
    }
  )

  it(/*
   * The switch is read as a boolean, and a string would be truthy.
   */
  'rejects a non-boolean otel.shouldAutoInjectTraceContext', () => {
    expect(() =>
      validateOptions(withOption('otel', { shouldAutoInjectTraceContext: 'false' }))
    ).toThrow(/options\.otel\.shouldAutoInjectTraceContext must be a boolean/)
  })

  it.each(['kebab-case', 'CAMEL', ''])(
    /*
     * An unknown `fieldFormat` silently behaves as `camelCase`, so a typo such as
     * `snake-case` ships the wrong field names and nothing reports it.
     */
    'rejects otel.fieldFormat %p',
    (value) => {
      expect(() => validateOptions(withOption('otel', { fieldFormat: value }))).toThrow(
        /options\.otel\.fieldFormat must be 'camelCase' or 'snake_case'/
      )
    }
  )

  it.each(['traceIdField', 'spanIdField', 'traceFlagsField'])(
    /*
     * An empty or non-string field name would write a key called `''` onto every entry
     * that carries a trace, or throw while the mixin builds it.
     */
    'rejects an empty or non-string otel.%s',
    (key) => {
      expect(() => validateOptions(withOption('otel', { [key]: '' }))).toThrow(
        new RegExp(`options\\.otel\\.${key} must be a non-empty string`)
      )
      expect(() => validateOptions(withOption('otel', { [key]: 7 }))).toThrow(
        new RegExp(`options\\.otel\\.${key} must be a non-empty string`)
      )
    }
  )
})
