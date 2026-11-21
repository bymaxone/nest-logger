/**
 * Verifies that a `redactPaths` entry is at most 256 characters: the name is compared with every
 * key of every record, so its length bounds that work, and a longer one is refused at startup by the
 * name of the option, without echoing it.
 *
 * Layer: server/config, tests.
 */
import { validateOptions } from './validate-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

const options = (redactPaths: string[]): BymaxLoggerModuleOptions => ({
  service: { name: 'app', version: '1.0.0' },
  redactPaths
})

describe('the length of a redactPaths entry', () => {
  /**
   * Given an entry of exactly 256 characters
   * When the options are validated
   * Then they are accepted
   */
  it('accepts 256 characters', () => {
    expect(() => validateOptions(options(['a'.repeat(256)]))).not.toThrow()
  })

  /**
   * Given an entry of 257 characters, the second of two
   * When the options are validated
   * Then they are refused by the name of the option and its index, and the entry is not echoed
   */
  it('refuses 257 characters by the option, without the value', () => {
    const entry = `SENTINEL${'a'.repeat(249)}`

    expect(() => validateOptions(options(['ok', entry]))).toThrow(
      '[BymaxLoggerModule] options.redactPaths[1] must be at most 256 characters. Received a string'
    )
    expect(() => validateOptions(options(['ok', entry]))).not.toThrow(/SENTINEL/)
  })
})
