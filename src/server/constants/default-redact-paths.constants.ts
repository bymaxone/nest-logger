/**
 * Default Pino `redact.paths` applied automatically by the library.
 *
 * These paths cover commonly-leaked PII and credentials. Consumers can:
 *   - Add more via the `redactPaths` option (merged with these defaults).
 *   - Disable all via `shouldDisableDefaultRedact: true` (NOT recommended).
 *
 * Path syntax follows `fast-redact` conventions (engine behind `pino.redact`):
 *   - Wildcard `*` matches **one level only** (NOT recursive).
 *   - `'*.password'`             → matches `body.password`, `meta.password`, …
 *   - `'*.*.password'`           → matches `body.user.password`, …
 *   - `'a.b.c'`                  → exact dot path
 *   - `'req.headers["x-api-key"]'` → bracket syntax for headers with hyphens
 *
 * For defense-in-depth coverage of nested payloads, depths 1-4 are listed
 * explicitly for every sensitive field via the {@link depth} helper.
 *
 * @see {@link https://github.com/davidmarkclements/fast-redact#wildcards}
 * @see {@link https://github.com/pinojs/pino/blob/main/docs/redaction.md}
 */

/**
 * Maximum wildcard depth covered by {@link depth} — `fast-redact` wildcards
 * are non-recursive, so the library lists each level explicitly. Four
 * levels match the deepest realistic nesting (`req.body.user.profile.x`)
 * without bloating the path list.
 */
export const REDACT_MAX_DEPTH = 4 as const

/**
 * Pre-computed wildcard prefixes from depth 1 (`*`) to {@link REDACT_MAX_DEPTH}.
 * Built from a range so the explicit depth contract lives in
 * {@link REDACT_MAX_DEPTH} instead of being smuggled in as a literal array.
 */
const WILDCARD_PREFIXES: readonly string[] = Array.from(
  { length: REDACT_MAX_DEPTH },
  (_, idx) => '*' + '.*'.repeat(idx)
)

/**
 * Generate wildcard variants from depth 1 to {@link REDACT_MAX_DEPTH} for a
 * given leaf field name.
 *
 * Exported so unit tests can validate the expansion contract without poking
 * at the private composition of {@link DEFAULT_REDACT_PATHS}.
 *
 * @example
 *   depth('password')
 *   // → ['*.password', '*.*.password', '*.*.*.password', '*.*.*.*.password']
 *
 * @param field — Sensitive leaf field name (e.g., `password`, `cpf`).
 * @returns Four wildcard paths covering depths 1 through {@link REDACT_MAX_DEPTH}.
 */
export const depth = (field: string): readonly string[] =>
  WILDCARD_PREFIXES.map((prefix) => `${prefix}.${field}`)

/**
 * Fields covered by every depth-1-to-4 wildcard. Centralized so the spec can
 * compute the expected length without hard-coding 113.
 */
export const REDACT_COMMON_FIELDS: readonly string[] = [
  // Passwords (5)
  'password',
  'passwordHash',
  'passwordConfirm',
  'newPassword',
  'oldPassword',
  // Tokens (6)
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'apiSecret',
  // MFA (3)
  'mfaSecret',
  'mfaRecoveryCodes',
  'totpSecret',
  // Payment / PCI DSS (5)
  'cardNumber',
  'cardCvv',
  'cvv',
  'cvc',
  'cardExpiry',
  // Personal documents — BR / LGPD (3)
  'cpf',
  'cnpj',
  'rg',
  // Generic secrets (4) — the most common short-form credential field names
  'secret',
  'clientSecret',
  'signingSecret',
  'privateKey',
  // Conservative PII (1) — consumer can disable if logging email is justified
  'email'
] as const

/**
 * HTTP headers that commonly carry secrets. Listed as absolute paths because
 * `fast-redact` wildcards do not traverse bracket-syntax keys.
 */
export const REDACT_ABSOLUTE_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]'
] as const

/**
 * Canonical list of redact paths merged into Pino's `redact.paths` option by
 * default. Expected length: 27 common fields × 4 depths + 5 absolute = **113**.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  ...REDACT_COMMON_FIELDS.flatMap((field) => depth(field)),
  ...REDACT_ABSOLUTE_PATHS
] as const
