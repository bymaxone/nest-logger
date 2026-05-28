import { LOG_KEYS_CONVENTION_REGEX } from '../../shared/constants/log-keys-convention.constants'
import { LOGGER_ERROR_CODES, type LoggerErrorCode } from './logger-error-codes.constants'

describe('LOGGER_ERROR_CODES', () => {
  it(/*
   * Frozen at runtime so consumers cannot mutate or extend the internal
   * error vocabulary, which would silently change how the library reports
   * its own setup/runtime failures.
   */
  'should be frozen at runtime', () => {
    expect(Object.isFrozen(LOGGER_ERROR_CODES)).toBe(true)
  })

  it(/*
   * Spec §13 fixes the catalog at 8 entries — drift would mean either an
   * addition not yet documented or an accidental removal.
   */
  'should expose exactly 8 entries (spec §13)', () => {
    expect(Object.keys(LOGGER_ERROR_CODES).length).toBe(8)
  })

  it(/*
   * Every value follows the public MODULE_ACTION_RESULT convention so the
   * library does not double-standard the rule it imposes on consumers.
   */
  'should have every value matching LOG_KEYS_CONVENTION_REGEX', () => {
    for (const value of Object.values(LOGGER_ERROR_CODES)) {
      expect(LOG_KEYS_CONVENTION_REGEX.test(value)).toBe(true)
    }
  })

  it(/*
   * Key and value must be identical so consumers can map either side back
   * to the original constant without a reverse lookup.
   */
  'should mirror each key to its own value', () => {
    for (const [key, value] of Object.entries(LOGGER_ERROR_CODES)) {
      expect(value).toBe(key)
    }
  })

  it(/*
   * The derived LoggerErrorCode type must cover the exact runtime values
   * so a future addition to the object propagates automatically into the
   * union type.
   */
  'should expose every spec-defined code via the LoggerErrorCode union', () => {
    const expected: LoggerErrorCode[] = [
      'LOGGER_INVALID_OPTIONS',
      'LOGGER_INVALID_LEVEL',
      'LOGGER_PRETTY_UNAVAILABLE',
      'LOGGER_OTEL_API_UNAVAILABLE',
      'LOGGER_DESTINATION_INIT_FAILED',
      'LOGGER_DESTINATION_WRITE_FAILED',
      'LOGGER_CONTEXT_OUT_OF_SCOPE',
      'LOGGER_ENTRY_TRUNCATED'
    ]
    const values = Object.values(LOGGER_ERROR_CODES)
    for (const code of expected) {
      expect(values).toContain(code)
    }
  })
})
