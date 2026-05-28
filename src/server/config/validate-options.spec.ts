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
    expect(() => validateOptions({ ...validOpts, level: 'verbose' as never })).toThrow(/level/i)
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
})
