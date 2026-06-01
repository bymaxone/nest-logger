/**
 * Regex enforcing the canonical Bymax log-key convention.
 *
 * The convention is `MODULE_ACTION_RESULT` (e.g., `USER_CREATED`,
 * `AUTH_LOGIN_SUCCESS`), but the regex accepts **two or more** uppercase words —
 * see spec §12.3 for reserved keys that legitimately use four words
 * (`HTTP_REQUEST_CLIENT_ERROR`, `LOGGER_DESTINATION_WRITE_FAILED`).
 *
 * Pattern: two mandatory uppercase-prefixed groups separated by `_`, plus one
 * optional third group. Within each group, `[A-Z0-9_]+` allows digits and
 * underscores after the leading uppercase letter, which enables additional
 * semantic words inside a group (e.g., `HTTP_REQUEST_CLIENT` is the first group
 * in `HTTP_REQUEST_CLIENT_ERROR`). As a side-effect, strings with a double
 * underscore (`HELLO__WORLD`) also pass; this is an accepted edge case.
 *
 * Enforcement rules:
 *   - At least 2 uppercase-prefixed words (`[A-Z][A-Z0-9_]+`)
 *   - Each pattern group starts with `A-Z`; no lowercase letters permitted
 *   - No leading or trailing underscores at the top level
 *
 * @example
 *   LOG_KEYS_CONVENTION_REGEX.test('USER_CREATED')              // true
 *   LOG_KEYS_CONVENTION_REGEX.test('AUTH_LOGIN_SUCCESS')        // true
 *   LOG_KEYS_CONVENTION_REGEX.test('HTTP_REQUEST_CLIENT_ERROR') // true (4 words)
 *   LOG_KEYS_CONVENTION_REGEX.test('login_success')             // false (lowercase)
 *   LOG_KEYS_CONVENTION_REGEX.test('LOGIN')                     // false (single word)
 */
export const LOG_KEYS_CONVENTION_REGEX = /^[A-Z][A-Z0-9_]+_[A-Z][A-Z0-9_]+(_[A-Z][A-Z0-9_]+)?$/
