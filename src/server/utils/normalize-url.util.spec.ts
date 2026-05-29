import { normalizeUrl } from './normalize-url.util'

describe('normalizeUrl', () => {
  it(/*
   * A canonical UUID v4 segment must collapse to `/:id`. This is the most
   * common identifier shape in REST routes — failing it would explode log
   * cardinality on every entity-by-id endpoint.
   */
  'should replace a UUID v4 segment', () => {
    expect(normalizeUrl('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736')).toBe('/users/:id')
  })

  it(/*
   * UUID v1 shares the 8-4-4-4-12 hex layout, so the same rule must catch it.
   * Guards against a regex that accidentally pins the version nibble.
   */
  'should replace a UUID v1 segment', () => {
    expect(normalizeUrl('/users/f47ac10b-58cc-11e1-b86c-0800200c9a66')).toBe('/users/:id')
  })

  it(/*
   * UUIDs may arrive upper-cased; the rule is case-insensitive. Protects the
   * `i` regex flag from being dropped.
   */
  'should replace an uppercase UUID segment', () => {
    expect(normalizeUrl('/users/4BF92F35-77B3-4DA6-A3CE-929D0E0E4736')).toBe('/users/:id')
  })

  it(/*
   * A 26-char Crockford base32 ULID must collapse to `/:id`. Isolates the ULID
   * rule so removing it is caught by mutation testing.
   */
  'should replace a ULID segment', () => {
    expect(normalizeUrl('/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/sessions/:id')
  })

  it(/*
   * A 21-char URL-safe nanoid must collapse to `/:id`. Isolates the nanoid
   * rule; the value mixes case, `_` and `-` so it cannot be mistaken for a
   * UUID, ULID, or numeric id.
   */
  'should replace a nanoid segment', () => {
    expect(normalizeUrl('/docs/V1StGXR8_Z5jdHi6B-myT')).toBe('/docs/:id')
  })

  it(/*
   * A purely numeric id segment must collapse to `/:id`. Isolates the numeric
   * rule.
   */
  'should replace a numeric id segment', () => {
    expect(normalizeUrl('/users/123')).toBe('/users/:id')
  })

  it(/*
   * Multiple ids of different kinds in one path must all be replaced — proves
   * the global flag and that the UUID and numeric rules compose.
   */
  'should replace every id in a path with mixed id types', () => {
    expect(normalizeUrl('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736/orders/456')).toBe(
      '/users/:id/orders/:id'
    )
  })

  it(/*
   * Repeated numeric ids in one path must all collapse — proves the numeric
   * rule's global flag specifically.
   */
  'should replace repeated numeric ids', () => {
    expect(normalizeUrl('/users/123/orders/456')).toBe('/users/:id/orders/:id')
  })

  it(/*
   * The query string must be stripped before normalization so query params
   * never leak into the log key. Exercises the "query present" branch.
   */
  'should remove the query string', () => {
    expect(normalizeUrl('/users/123?fields=name')).toBe('/users/:id')
  })

  it(/*
   * A complex multi-param query must be fully removed, not just the first
   * param — guards the slice boundary against an off-by-one mutation.
   */
  'should remove a complex multi-param query string', () => {
    expect(normalizeUrl('/users/123?a=1&b=2&c=3')).toBe('/users/:id')
  })

  it(/*
   * An empty URL must return an empty string, never throw. Exercises the
   * "no query string" branch with the smallest possible input.
   */
  'should return an empty string for an empty URL', () => {
    expect(normalizeUrl('')).toBe('')
  })

  it(/*
   * A lone slash has no identifier and must pass through unchanged. Confirms
   * the numeric rule does not match a bare `/`.
   */
  'should leave a root slash unchanged', () => {
    expect(normalizeUrl('/')).toBe('/')
  })

  it(/*
   * A static path with no identifier must be returned verbatim — the function
   * must not normalize ordinary route segments.
   */
  'should leave an id-free path unchanged', () => {
    expect(normalizeUrl('/health/live')).toBe('/health/live')
  })

  it(/*
   * A URL-safe token of 20 chars (one short of a nanoid) must NOT be replaced.
   * Pins the nanoid length quantifier so it cannot loosen to `{20}` or less.
   */
  'should not replace a token shorter than a nanoid', () => {
    expect(normalizeUrl('/files/V1StGXR8_Z5jdHi6B-my')).toBe('/files/V1StGXR8_Z5jdHi6B-my')
  })

  it(/*
   * A truncated UUID (only the first two groups, leading hex letter) matches no
   * rule and must pass through untouched. Pins the UUID rule to the full
   * 8-4-4-4-12 shape.
   */
  'should not replace a truncated UUID', () => {
    expect(normalizeUrl('/items/f47ac10b-58cc')).toBe('/items/f47ac10b-58cc')
  })

  it(/*
   * A 22-char URL-safe segment is NOT a nanoid (wrong length) and must NOT be
   * partially consumed into `/:idv`. Pins the nanoid boundary lookahead — the
   * regression guard for the partial-segment-match bug.
   */
  'should not partially replace a segment longer than a nanoid', () => {
    expect(normalizeUrl('/files/abcdefghijklmnopqrstuv')).toBe('/files/abcdefghijklmnopqrstuv')
  })

  it(/*
   * A 27-char Crockford segment is NOT a ULID (wrong length) and must NOT be
   * partially consumed. Pins the ULID boundary lookahead. The value starts with
   * a letter so the numeric rule (which grabs leading digits) cannot interfere.
   */
  'should not partially replace a segment longer than a ULID', () => {
    expect(normalizeUrl('/sessions/ABCDEFGHJKMNPQRSTVWXYZABCDE')).toBe(
      '/sessions/ABCDEFGHJKMNPQRSTVWXYZABCDE'
    )
  })

  it(/*
   * Only `?` delimits the query string; a `#` fragment is treated as a literal
   * path character (real HTTP requests never carry one). The numeric id before
   * the fragment is still normalized, the fragment is preserved.
   */
  'should split on "?" only and preserve a fragment literally', () => {
    expect(normalizeUrl('/users/123#section')).toBe('/users/:id#section')
  })

  it(/*
   * A query string attached to a non-id path must still be stripped, leaving
   * the static path intact — proves stripping is independent of id matching.
   */
  'should strip a query string from an id-free path', () => {
    expect(normalizeUrl('/search?q=hello')).toBe('/search')
  })
})
