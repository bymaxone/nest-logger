import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { validateOptions } from './validate-options'

describe('validateOptions', () => {
  const validOpts: BymaxLoggerModuleOptions = {
    service: { name: 'app', version: '1.0.0' }
  }

  it(/*
   * The minimal-valid shape (only `service`) must pass — every other field
   * is optional. Guards against an accidental tightening of the required
   * surface.
   */
  'should accept the minimal valid options', () => {
    expect(() => validateOptions(validOpts)).not.toThrow()
  })

  it.each([
    ['undefined service', { ...validOpts, service: undefined as never }],
    ['empty service.name', { ...validOpts, service: { name: '', version: '1.0.0' } }],
    ['whitespace service.name', { ...validOpts, service: { name: '   ', version: '1.0.0' } }],
    ['empty service.version', { ...validOpts, service: { name: 'app', version: '' } }],
    ['whitespace service.version', { ...validOpts, service: { name: 'app', version: '  ' } }]
  ])(
    /*
     * Service metadata is mandatory for OTel-aligned `service.name`/
     * `service.version` propagation — accept nothing that would emit empty
     * strings into the log stream.
     */
    'should throw when %s',
    (_label, opts) => {
      expect(() => validateOptions(opts)).toThrow(/service/i)
    }
  )

  it(/*
   * Unknown `level` strings must be rejected so consumers spot the typo at
   * bootstrap rather than discover silent drops at runtime.
   */
  'should throw when level is not a valid LogLevel', () => {
    // Assert that at least one comma-space separator appears in the level list
    // so the `join(', ')` literal is pinned — an empty separator mutant collapses
    // the list into a single unreadable token.
    expect(() => validateOptions({ ...validOpts, level: 'verbose' as never })).toThrow(
      /options\.level must be one of: .*, /
    )
  })

  it(/*
   * Non-string service.name must be rejected — pins the `typeof !== 'string'`
   * guard so it cannot be mutated away. TypeScript callers cannot reach this
   * branch, but JavaScript callers can.
   */
  'should throw when service.name is not a string', () => {
    expect(() =>
      validateOptions({ ...validOpts, service: { name: 123 as never, version: '1.0.0' } })
    ).toThrow('[BymaxLoggerModule] options.service.name must be a non-empty string')
  })

  it(/*
   * Non-string service.version must be rejected — same guard as above, for the
   * version field.
   */
  'should throw when service.version is not a string', () => {
    expect(() =>
      validateOptions({ ...validOpts, service: { name: 'app', version: [] as never } })
    ).toThrow('[BymaxLoggerModule] options.service.version must be a non-empty string')
  })

  it.each([
    ['zero', 0],
    ['negative', -1]
  ])(
    /*
     * `maxEntrySizeBytes` is a hard truncation gate — non-positive values
     * would either disable logging entirely (0) or be nonsensical (negative).
     */
    'should throw when maxEntrySizeBytes is %s',
    (_label, value) => {
      expect(() => validateOptions({ ...validOpts, maxEntrySizeBytes: value })).toThrow(
        /maxEntrySizeBytes/
      )
    }
  )

  it(/*
   * A positive maxEntrySizeBytes must still pass — keeps the validator from
   * over-rejecting in the happy path.
   */
  'should accept a positive maxEntrySizeBytes', () => {
    expect(() => validateOptions({ ...validOpts, maxEntrySizeBytes: 1024 })).not.toThrow()
  })

  it(/*
   * Every valid LogLevel must pass — guards against an accidental removal
   * from the VALID_LEVELS allow-list inside the validator.
   */
  'should accept every valid LogLevel', () => {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
    for (const level of levels) {
      expect(() => validateOptions({ ...validOpts, level })).not.toThrow()
    }
  })

  it(/*
   * `redactStrategy` selects the engine behind the DEFAULT PII protection, so a
   * typo must fail loudly at bootstrap rather than silently falling back to one
   * of the two — a silent fallback to the wrong engine is a security posture
   * change nobody would notice.
   */
  'should reject an unknown redactStrategy', () => {
    expect(() => validateOptions({ ...validOpts, redactStrategy: 'name' as never })).toThrow(
      /redactStrategy/
    )
  })

  it(/*
   * Both documented strategies, and omitting the option entirely, must pass.
   */
  'should accept the documented redactStrategy values and undefined', () => {
    expect(() => validateOptions({ ...validOpts, redactStrategy: 'names' })).not.toThrow()
    expect(() => validateOptions({ ...validOpts, redactStrategy: 'paths' })).not.toThrow()
    expect(() => validateOptions(validOpts)).not.toThrow()
  })
})

describe('validateOptions — P1 closed-set options', () => {
  const base = { service: { name: 'svc', version: '1.0.0' } }

  it.each([['nested' as const], ['flat' as const]])(
    'accepts resourceFormat %s',
    (resourceFormat) => {
      expect(() => validateOptions({ ...base, resourceFormat })).not.toThrow()
    }
  )

  it(/*
   * An unrecognised value falls through to the nested branch and SHIPS, so a
   * typo in a config file would look like it worked while emitting a shape the
   * consumer did not ask for.
   */
  'rejects an unrecognised resourceFormat', () => {
    expect(() => validateOptions({ ...base, resourceFormat: 'nested ' as never })).toThrow(
      /resourceFormat must be 'nested' or 'flat'/
    )
  })

  it.each([['pino' as const], ['semconv' as const], ['both' as const]])(
    'accepts errorFormat %s',
    (errorFormat) => {
      expect(() => validateOptions({ ...base, errorFormat })).not.toThrow()
    }
  )

  it(/*
   * Only `'pino'` short-circuits, so an unrecognised value behaves as `'both'` —
   * silently adding attributes the consumer never enabled.
   */
  'rejects an unrecognised errorFormat', () => {
    expect(() => validateOptions({ ...base, errorFormat: 'semconv2' as never })).toThrow(
      /errorFormat must be 'pino', 'semconv' or 'both'/
    )
  })

  it.each([['event.name'], ['otel.event_name']])('accepts eventNameField %p', (eventNameField) => {
    expect(() => validateOptions({ ...base, eventNameField })).not.toThrow()
  })

  it('accepts eventNameField false, which means emit nothing', () => {
    expect(() => validateOptions({ ...base, eventNameField: false })).not.toThrow()
  })

  it(/*
   * An empty field name would write a key called `''` onto every structured
   * entry — valid JSON, unqueryable, and impossible to notice in a dashboard.
   */
  'rejects an empty eventNameField', () => {
    expect(() => validateOptions({ ...base, eventNameField: '' })).toThrow(
      /eventNameField must be a non-empty string or false/
    )
  })

  it.each([[true], [42], [null]])('rejects a non-string eventNameField (%p)', (eventNameField) => {
    expect(() => validateOptions({ ...base, eventNameField: eventNameField as never })).toThrow(
      /eventNameField must be a non-empty string or false/
    )
  })
})
