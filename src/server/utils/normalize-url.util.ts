/**
 * URL normalization for HTTP request logging.
 *
 * Layer: server/utils — a pure helper consumed by `HttpLoggingInterceptor` to
 * collapse high-cardinality identifiers in request paths into a single `/:id`
 * placeholder. Without it, every distinct UUID / numeric id would mint a new
 * log-key value and explode the cardinality of log-aggregation queries
 * (Datadog, Loki, Elastic), making per-route dashboards unusable.
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

/** Placeholder substituted for a path segment that looks like a credential. */
const SECRET_PLACEHOLDER = ':redacted'
/** Hex digest or token: 32 or more hex digits (a 128-bit value, SHA-256, a session id). */
const HEX_SECRET_REGEX = /^[0-9a-f]{32,}$/i
/** JWT: three base64url parts, the first being the encoded `{"` header every JWT starts with. */
const JWT_SECRET_REGEX = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/
/**
 * Opaque token: 32 or more base64 or base64url characters, with the padding a base64 value ends in.
 * A segment is tested decoded, and a `/` that arrived as `%2F` is part of a standard-base64 token.
 */
const TOKEN_SECRET_REGEX = /^[A-Za-z0-9_+/-]{32,}={0,2}$/
/** A lowercase slug or snake_case name (`my-long-article-title-2024`), which is a name and not a token. */
const SLUG_REGEX = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/
/** A run of 32 or more hex digits anywhere in a segment, which a prefix such as `rst_` does not hide. */
const HEX_RUN_REGEX = /[0-9a-f]{32}/i
/** A UUID, which is an identifier: `/:id` in `url`, and kept in `fullUrl` for debugging. */
const UUID_SEGMENT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An email address, which is personal data and the usual carrier of an account-recovery link. */
const EMAIL_SECRET_REGEX = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/

/**
 * Read a path segment the way the router does, which is percent-decoded. A segment that is not valid
 * percent-encoding is read as it was written.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Whether one path segment is a credential: a long hex value, a JWT, a long opaque token that is not
 * a slug or a UUID, an email address, or anything one of the host's own patterns matches.
 */
function isSecretSegment(segment: string, extra: readonly RegExp[]): boolean {
  if (segment === '') return false
  const decoded = decodeSegment(segment)
  return (
    looksLikeToken(decoded) ||
    looksLikeToken(withoutExtension(decoded)) ||
    EMAIL_SECRET_REGEX.test(decoded) ||
    extra.some((pattern) => matchesFresh(pattern, decoded))
  )
}

/** The segment without a trailing file extension: `<token>.pdf` carries the token. */
function withoutExtension(segment: string): string {
  const dot = segment.lastIndexOf('.')
  return dot > 0 && segment.length - dot <= 9 ? segment.slice(0, dot) : segment
}

/** A hex value, a JWT, or an opaque token that is not a slug or a UUID. */
function looksLikeToken(value: string): boolean {
  return (
    HEX_SECRET_REGEX.test(value) ||
    HEX_RUN_REGEX.test(value) ||
    JWT_SECRET_REGEX.test(value) ||
    (TOKEN_SECRET_REGEX.test(value) && !SLUG_REGEX.test(value) && !UUID_SEGMENT_REGEX.test(value))
  )
}

/** `RegExp.test` on a pattern that may carry the `g` or `y` flag, without reading or leaving `lastIndex`. */
function matchesFresh(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  const matched = pattern.test(value)
  pattern.lastIndex = 0
  return matched
}

/**
 * The raw segments of a request path that are credentials.
 *
 * @param url - The request URL, path with or without a query string.
 * @param extra - The host's own patterns, each tested against one percent-decoded segment.
 * @returns The segments as the request wrote them, in order, without repeats.
 */
export function secretPathSegments(url: string, extra: readonly RegExp[] = []): string[] {
  const found = new Set<string>()
  for (const segment of stripQueryString(url).split('/')) {
    if (isSecretSegment(segment, extra)) found.add(segment)
  }
  return [...found]
}

/**
 * Replace each path segment that is a credential with `:redacted`, keeping the route shape.
 *
 * Reset, verification and invitation links carry their token in the path, where neither the query
 * stripping nor key-name redaction can reach it: it is the value of a string field. The query string
 * is not touched here; strip it first.
 *
 * @param path - A request path without its query string.
 * @param extra - The host's own patterns, each tested against one percent-decoded segment.
 * @returns The path with each credential segment replaced.
 * @example
 *   scrubSecretSegments('/auth/reset/a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c') // → '/auth/reset/:redacted'
 */
export function scrubSecretSegments(path: string, extra: readonly RegExp[] = []): string {
  return path
    .split('/')
    .map((segment) => (isSecretSegment(segment, extra) ? SECRET_PLACEHOLDER : segment))
    .join('/')
}

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
 * @param extra - The host's own credential patterns ({@link scrubSecretSegments}).
 * @returns The normalized path with credentials as `:redacted` and identifiers collapsed to `/:id`.
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
export function normalizeUrl(url: string, extra: readonly RegExp[] = []): string {
  return scrubSecretSegments(stripQueryString(url), extra)
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

/**
 * Remove the raw query string and the credential path segments of the request from a text that is
 * about to be logged.
 *
 * Nest words its not-found message as `Cannot GET /path?code=...`, with the whole URL, and an
 * application may echo the URL in a message of its own. A `url` field is scrubbed on its own, but a
 * message is free text, which no key-name redaction can censor, so the query is cut out of it by
 * exact substring and each credential segment (`/auth/reset/<token>`) becomes `:redacted`. Only the
 * bytes the request carried are matched: a URL a message words in another encoding is not found, and
 * is the application's own text.
 *
 * @param text - The text to be logged.
 * @param extra - The host's own credential patterns ({@link scrubSecretSegments}).
 * @param urls - The request URLs (`originalUrl` and `url`, which differ for a mounted request).
 * @returns The text without the `?`-led query or the credential segments of any of the URLs; a bare
 *   `?` is not a query.
 */
export function withoutRequestSecrets(
  text: string,
  extra: readonly RegExp[],
  ...urls: Array<string | undefined>
): string {
  let result = text
  const segments = new Set<string>()
  for (const url of urls) {
    if (url === undefined) continue
    const queryStart = url.indexOf('?')
    if (queryStart !== -1 && url.length - queryStart > 1) {
      result = result.split(url.slice(queryStart)).join('')
    }
    for (const segment of secretPathSegments(url, extra)) segments.add(segment)
  }
  if (segments.size > 0) {
    // One pass, longest first: replacing one credential at a time would cut a credential that is the
    // start of a longer one out of the longer, and leave its remaining bytes in the text.
    const alternation = [...segments]
      .sort((left, right) => right.length - left.length)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')
    result = result.replace(new RegExp(alternation, 'g'), SECRET_PLACEHOLDER)
  }
  return result
}

/**
 * {@link withoutRequestSecrets} for a field that is usually text: a value that is not a string is
 * returned as it is.
 *
 * @param value - A field that is usually text.
 * @param extra - The host's own credential patterns.
 * @param urls - The request URLs.
 * @returns The text without the query or credential segments, or `value` unchanged when it is not a string.
 */
export function withoutRequestSecretsIfText(
  value: unknown,
  extra: readonly RegExp[],
  ...urls: Array<string | undefined>
): unknown {
  return typeof value === 'string' ? withoutRequestSecrets(value, extra, ...urls) : value
}
