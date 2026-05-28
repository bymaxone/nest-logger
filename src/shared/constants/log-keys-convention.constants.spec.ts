import { LOG_KEYS_CONVENTION_REGEX } from './log-keys-convention.constants'

describe('LOG_KEYS_CONVENTION_REGEX', () => {
  describe('valid log keys', () => {
    it.each([
      ['two segments', 'USER_CREATED'],
      ['three segments', 'AUTH_LOGIN_SUCCESS'],
      ['three segments with rich vocabulary', 'PAYMENT_REFUND_PROCESSED'],
      ['segments containing digits', 'HTTP2_REQUEST_OK'],
      ['four segments (reserved-key shape)', 'HTTP_REQUEST_CLIENT_ERROR']
    ])(
      /*
       * Accept keys that satisfy the MODULE_ACTION_RESULT convention.
       * Protects the public contract for log-aggregation queries that depend on
       * predictable, uppercase, underscore-separated identifiers.
       */
      'should accept %s (%s)',
      (_label, key) => {
        expect(LOG_KEYS_CONVENTION_REGEX.test(key)).toBe(true)
      }
    )
  })

  describe('invalid log keys', () => {
    it.each([
      ['lowercase characters', 'user_created'],
      ['single segment', 'LOGIN'],
      ['hyphen separator', 'USER-CREATED'],
      ['empty string', ''],
      ['whitespace inside', 'USER CREATED'],
      ['leading underscore', '_USER_CREATED'],
      ['trailing whitespace', 'USER_CREATED ']
    ])(
      /*
       * Reject keys that violate the convention.
       * Prevents accidental drift to inconsistent shapes (lowercase, hyphenated,
       * single-segment) that would break dashboards and alerts.
       */
      'should reject %s (%s)',
      (_label, key) => {
        expect(LOG_KEYS_CONVENTION_REGEX.test(key)).toBe(false)
      }
    )
  })
})
