/**
 * Regex enforcing the canonical Bymax log-key convention.
 *
 * The convention is `MODULE_ACTION_RESULT` (e.g., `USER_CREATED`,
 * `AUTH_LOGIN_SUCCESS`), but the regex accepts **two or more** uppercase
 * segments — see spec §12.3 for reserved keys that legitimately use four
 * segments (`HTTP_REQUEST_CLIENT_ERROR`, `LOGGER_DESTINATION_WRITE_FAILED`).
 *
 * Pattern rules:
 *   - At least 2 segments separated by `_`, no upper bound
 *   - Each segment starts with an uppercase letter (`A-Z`)
 *   - Segments may contain uppercase letters, digits, and underscores (`A-Z0-9_`)
 *
 * @example
 *   LOG_KEYS_CONVENTION_REGEX.test('USER_CREATED')              // true
 *   LOG_KEYS_CONVENTION_REGEX.test('AUTH_LOGIN_SUCCESS')        // true
 *   LOG_KEYS_CONVENTION_REGEX.test('HTTP_REQUEST_CLIENT_ERROR') // true (4 segments)
 *   LOG_KEYS_CONVENTION_REGEX.test('login_success')             // false (lowercase)
 *   LOG_KEYS_CONVENTION_REGEX.test('LOGIN')                     // false (single segment)
 */
export const LOG_KEYS_CONVENTION_REGEX = /^[A-Z][A-Z0-9_]+_[A-Z][A-Z0-9_]+(_[A-Z][A-Z0-9_]+)?$/
