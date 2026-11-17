/**
 * Validation of `maxStringLength` by `validateOptions`: an integer from 64 to 2147483647, or not
 * given, with the same message shape as the other size options.
 *
 * Layer: server/config, tests. The option bounds the length of every string of a log record, so a
 * value that is not a whole number in range would be read per entry as a limit that never trips or
 * that cuts the library's own fields; the validator is where it surfaces, at bootstrap, by name.
 */
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { validateOptions } from './validate-options'

const base: BymaxLoggerModuleOptions = { service: { name: 'app', version: '1.0.0' } }

/** The options with `maxStringLength` set to `value`, bypassing the compile-time types. */
const withLimit = (value: unknown): BymaxLoggerModuleOptions =>
  ({ ...base, maxStringLength: value }) as BymaxLoggerModuleOptions

describe('validateOptions: maxStringLength', () => {
  it.each([
    ['not given', undefined],
    ['the smallest', 64],
    ['an ordinary value', 4096],
    ['the largest', 2_147_483_647]
  ])('accepts a limit that is %s', (_label, value) => {
    expect(() => validateOptions(withLimit(value))).not.toThrow()
  })

  /*
   * Every class of value a config file or an untyped caller can hand over: `NaN` and the infinities
   * pass an ordering comparison, a fraction is not a number of characters, a numeric string
   * compares by coercion and `null` is not "not given".
   */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['one', 1],
    ['one under the smallest', 63],
    ['a fraction', 64.5],
    ['a fraction above the smallest', 100.5],
    ['a numeric string', '4096'],
    ['null', null],
    ['one over the largest', 2_147_483_648],
    ['a boolean', true]
  ])('rejects a limit that is %s', (_label, value) => {
    expect(() => validateOptions(withLimit(value))).toThrow(
      /options\.maxStringLength must be an integer from 64 to 2147483647/
    )
  })

  it('shows the received value in the message', () => {
    expect(() => validateOptions(withLimit(63))).toThrow(
      new Error(
        '[BymaxLoggerModule] options.maxStringLength must be an integer from 64 to 2147483647. Got: 63'
      )
    )
  })
})

describe('validateOptions: maxStringLength and redactCensor', () => {
  const withCensor = (limit: number | undefined, censor: string): BymaxLoggerModuleOptions =>
    ({ ...base, maxStringLength: limit, redactCensor: censor }) as BymaxLoggerModuleOptions

  /** The message `validateOptions` throws for `options`, or `undefined` when it accepts them. */
  const refusalOf = (options: BymaxLoggerModuleOptions): string | undefined => {
    try {
      validateOptions(options)
    } catch (error) {
      return (error as Error).message
    }
    return undefined
  }

  /*
   * The cut leaves a string of at most the limit whole, and the censor is the text a consumer looks
   * for in place of a secret, so a censor longer than the limit would be cut and no longer match.
   * It is refused where the options meet, at bootstrap, and not left to the cut.
   */
  it('refuses a redactCensor longer than maxStringLength, naming both options', () => {
    expect(refusalOf(withCensor(64, 'R'.repeat(65)))).toBe(
      '[BymaxLoggerModule] options.redactCensor must be at most 64 characters when maxStringLength is set'
    )
  })

  it.each([
    ['one under the limit', 63],
    ['exactly the limit', 64]
  ])('accepts a redactCensor that is %s', (_label, length) => {
    expect(refusalOf(withCensor(64, 'R'.repeat(length)))).toBeUndefined()
  })

  it('accepts a redactCensor of any length while maxStringLength is not set', () => {
    expect(refusalOf(withCensor(undefined, 'R'.repeat(5000)))).toBeUndefined()
  })

  it('does not echo the censor in the message', () => {
    const censor = 'SENTINEL-' + 'R'.repeat(64)

    expect(refusalOf(withCensor(64, censor))).not.toContain('SENTINEL')
  })
})
