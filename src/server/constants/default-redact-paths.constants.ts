/**
 * The library's default PII/credential coverage, in two forms.
 *
 * {@link REDACT_COMMON_FIELDS} is the CANONICAL form: a flat list of sensitive
 * field NAMES. Under the default `redactStrategy: 'names'` it becomes the set a
 * single recursive walk matches against, catching each name at ANY depth and in
 * any position (see `redact-by-name.util.ts`).
 *
 * {@link DEFAULT_REDACT_PATHS} is the LEGACY form: the same names expanded into
 * `fast-redact` paths at wildcard depths 1–4. It is still exported (public API,
 * append-only by contract) and is still what feeds Pino under the opt-in
 * `redactStrategy: 'paths'`, but it is no longer the default engine — it costs
 * ~107 µs per log entry and stops at four levels of nesting.
 *
 * Consumers can:
 *   - Add more via the `redactPaths` option (always `fast-redact` path syntax,
 *     applied on top of whichever strategy is active).
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
 * The canonical sensitive-field-name set.
 *
 * Under the default `redactStrategy: 'names'` this list IS the redaction
 * contract: a value is censored when its key name appears here, at any depth.
 * Under the legacy `'paths'` strategy the same names are expanded to depths 1–4
 * by {@link depth} to build {@link DEFAULT_REDACT_PATHS}.
 *
 * Append-only: a name may be added in a minor release; removing one requires a
 * major, because a field that silently stopped being redacted is a leak no
 * consumer would notice.
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
  'email',
  // Credential-bearing HTTP header names (5). These also appear in
  // {@link REDACT_ABSOLUTE_PATHS}, pinned to the `req.headers` / `res.headers`
  // shapes — which covered ONLY those two shapes. A headers bag logged under any
  // other key (`logger.info(k, m, u, { headers: req.headers })`, one of the most
  // common things written while debugging an integration) wrote the bearer token
  // in clear. Listed here as bare names, they are caught wherever they appear.
  // Node lower-cases inbound header names, so the lower-case spelling is the one
  // that can actually reach a log.
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token'
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
 * The legacy `fast-redact` path expansion of {@link REDACT_COMMON_FIELDS}:
 * every name at the record root plus wildcard depths 1–4, followed by the
 * absolute header paths. Length is derived, not fixed — `fields × 5 + absolute`.
 *
 * Fed to Pino only under the opt-in `redactStrategy: 'paths'`. Kept exported at
 * full fidelity because it is public API and append-only by contract.
 *
 * The bare field names come first, at depth 0 — the log record's own root.
 * `emitStructured` spreads caller metadata there (`{ ...metadata, logKey, ... }`),
 * so a field named `password` passed as metadata lands at the root, which the
 * depth-1-and-deeper wildcards below never reach (`fast-redact`'s `*` matches a
 * level, not the root). Without the bare name the library's own documented call
 * `logger.info(key, msg, userId, { password })` would write the password in clear.
 * Listing it makes the default set cover a sensitive field wherever it appears.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  ...REDACT_COMMON_FIELDS,
  ...REDACT_COMMON_FIELDS.flatMap((field) => depth(field)),
  ...REDACT_ABSOLUTE_PATHS
] as const
