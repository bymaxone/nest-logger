import { LOG_KEYS_CONVENTION_REGEX } from './log-keys-convention.constants'
import { RESERVED_LOG_KEYS, type ReservedLogKey } from './reserved-log-keys.constants'

describe('RESERVED_LOG_KEYS', () => {
  it(/*
   * The runtime object must be frozen so consumers cannot mutate or extend
   * the reserved set, which would silently shift the meaning of indexed
   * log events in third-party dashboards.
   */
  'should be frozen at runtime', () => {
    expect(Object.isFrozen(RESERVED_LOG_KEYS)).toBe(true)
  })

  it(/*
   * Each entry must be a non-empty string so log consumers can safely
   * index on the value without nullability guards.
   */
  'should expose only non-empty string values', () => {
    const values = Object.values(RESERVED_LOG_KEYS)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it(/*
   * Every reserved value must satisfy the public MODULE_ACTION_RESULT
   * convention regex. Locks the library's own keys to the same shape it
   * asks consumers to use, preventing a credibility gap.
   */
  'should have every value matching LOG_KEYS_CONVENTION_REGEX', () => {
    for (const value of Object.values(RESERVED_LOG_KEYS)) {
      expect(LOG_KEYS_CONVENTION_REGEX.test(value)).toBe(true)
    }
  })

  it(/*
   * Key and value must be identical for each entry so consumers can map
   * either side back to the original constant without a reverse lookup.
   */
  'should mirror each key to its own value', () => {
    for (const [key, value] of Object.entries(RESERVED_LOG_KEYS)) {
      expect(value).toBe(key)
    }
  })

  it(/*
   * The derived ReservedLogKey type must cover exactly the runtime values.
   * Guards against silent drift between the type and the runtime object
   * (e.g., if a new key is added but the type derivation breaks).
   */
  'should match the ReservedLogKey union type via the values', () => {
    const values = Object.values(RESERVED_LOG_KEYS) as ReservedLogKey[]
    expect(values).toContain('LOGGER_BOOTSTRAP_OK')
    expect(values).toContain('HTTP_REQUEST_START')
    expect(values).toContain('LOGGER_ENTRY_TRUNCATED')
  })
})
