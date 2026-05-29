/**
 * URL normalization for HTTP request logging.
 *
 * Layer: server/utils — a pure helper consumed by `HttpLoggingInterceptor` to
 * collapse high-cardinality identifiers in request paths into a single `/:id`
 * placeholder. Without it, every distinct UUID / numeric id would mint a new
 * log-key value and explode the cardinality of log-aggregation queries
 * (Datadog, Loki, Elastic), making per-route dashboards unusable.
 *
 * See `docs/development_plan.md` §4.1 for the design rationale.
 */

// Each fixed-length pattern ends with a negative lookahead asserting the next
// character is NOT another character of the same class. Without it the regex
// would partially consume a longer segment (e.g. a 22-char slug → `/:idv`),
// minting a corrupt, high-cardinality log key. The lookahead pins the match to
// an exact-length identifier that ends at a segment boundary.
/** UUID (8-4-4-4-12 hex), case-insensitive — covers v1 through v5. */
const UUID_REGEX = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi
/** ULID — 26 chars of Crockford base32 (excludes I, L, O, U). */
const ULID_REGEX = /\/[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-HJKMNP-TV-Z])/g
/** nanoid — 21 URL-safe chars at the default size (A-Z a-z 0-9 _ -). */
const NANOID_REGEX = /\/[A-Za-z0-9_-]{21}(?![A-Za-z0-9_-])/g
/** Numeric identifier — one or more digits in a path segment. */
const NUMERIC_ID_REGEX = /\/\d+/g

/** Placeholder substituted for every recognized identifier. */
const ID_PLACEHOLDER = '/:id'

/**
 * Normalize a request URL by stripping its query string and replacing
 * identifier path segments with the `/:id` placeholder.
 *
 * Recognized identifiers, replaced in this order (broadest-but-most-specific
 * first so a ULID is never partially consumed by the shorter nanoid rule):
 *   1. UUIDs (8-4-4-4-12 hex, any case)
 *   2. ULIDs (26-char Crockford base32)
 *   3. nanoids (21-char URL-safe)
 *   4. Numeric ids (`\d+`)
 *
 * Pure function: no I/O, no mutation, no side effects.
 *
 * @param url - The raw request URL (path plus optional query string).
 * @returns The normalized path with identifiers collapsed to `/:id`.
 * @example
 *   normalizeUrl('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736')
 *   // → '/users/:id'
 * @example
 *   normalizeUrl('/users/123?fields=name')
 *   // → '/users/:id'
 * @example
 *   normalizeUrl('/users/123/orders/456')
 *   // → '/users/:id/orders/:id'
 * @example
 *   normalizeUrl('/health')
 *   // → '/health'
 */
export function normalizeUrl(url: string): string {
  return stripQueryString(url)
    .replace(UUID_REGEX, ID_PLACEHOLDER)
    .replace(ULID_REGEX, ID_PLACEHOLDER)
    .replace(NANOID_REGEX, ID_PLACEHOLDER)
    .replace(NUMERIC_ID_REGEX, ID_PLACEHOLDER)
}

/**
 * Strip the query string from a URL, returning only the path portion.
 *
 * Used to keep query parameters (which routinely carry secrets — reset tokens,
 * OAuth codes, signed-URL signatures) out of logged URLs. Pino's `redact.paths`
 * cannot scrub substrings inside a string value, so the query must be removed
 * before the URL is logged.
 *
 * Uses indexOf/slice rather than `split('?')[0]`: under `noUncheckedIndexedAccess`
 * the indexed form needs a `?? ''` fallback runtime can never reach, leaving an
 * uncoverable branch. Both arms of this ternary are reachable.
 *
 * @param url - The raw request URL (path plus optional query string).
 * @returns The path portion, without the `?`-delimited query string.
 * @example
 *   stripQueryString('/reset?token=secret') // → '/reset'
 */
export function stripQueryString(url: string): string {
  const queryStart = url.indexOf('?')
  return queryStart === -1 ? url : url.slice(0, queryStart)
}
