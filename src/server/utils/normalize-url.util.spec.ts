import {
  normalizeUrl,
  scrubSecretSegments,
  secretPathSegments,
  withoutRequestSecrets,
  withoutRequestSecretsIfText
} from './normalize-url.util'

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

describe('withoutRequestSecrets, on a query', () => {
  const QUERY = '?code=SECRET-CODE&state=SECRET-STATE'

  it.each([
    ['a Nest not-found message', `Cannot GET /missing${QUERY}`, 'Cannot GET /missing'],
    ['a message that echoes the URL twice', `${QUERY} and again ${QUERY}`, ' and again '],
    ['a message without the query', 'Cannot GET /missing', 'Cannot GET /missing']
  ])('removes the query of the request from %s', (_name, text, expected) => {
    expect(withoutRequestSecrets(text, [], `/missing${QUERY}`)).toBe(expected)
  })

  it('removes the query of every URL given, so a mounted request is covered by either', () => {
    expect(withoutRequestSecrets('a?x=1 b?y=2', [], '/api/a?x=1', '/a?y=2')).toBe('a b')
  })

  it.each([
    ['no URL', []],
    ['an undefined URL', [undefined]],
    ['a URL with no query', ['/missing']],
    ['a URL whose query is only the mark', ['/missing?']]
  ])('leaves the text as it is for %s', (_name, urls) => {
    expect(withoutRequestSecrets('is it? yes?', [], ...urls)).toBe('is it? yes?')
  })

  it('removes the raw bytes of the query, which is how Nest words its message', () => {
    expect(withoutRequestSecrets('Cannot GET /x?t=a%20b%2Fc', [], '/x?t=a%20b%2Fc')).toBe(
      'Cannot GET /x'
    )
  })

  it('does not remove a query written in another encoding than the request carried', () => {
    expect(withoutRequestSecrets('Cannot GET /x?t=a b/c', [], '/x?t=a%20b%2Fc')).toBe(
      'Cannot GET /x?t=a b/c'
    )
  })
})

const HEX_64 = 'a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
const TOKEN = 'Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZkdISUo'

describe('scrubSecretSegments', () => {
  it.each([
    ['a 64-digit hex token', `/auth/reset/${HEX_64}`],
    ['the shortest hex token, 32 digits', `/auth/reset/${HEX_64.slice(0, 32)}`],
    ['an upper-case hex token', `/auth/reset/${HEX_64.toUpperCase()}`],
    ['a JWT', `/auth/reset/${JWT}`],
    ['an opaque base64url token', `/invite/${TOKEN}`],
    ['an email address', '/unsubscribe/someone.private@example.com'],
    ['a percent-encoded email address', '/unsubscribe/someone.private%40example.com']
  ])('replaces %s with the placeholder and keeps the route', (_name, path) => {
    const scrubbed = scrubSecretSegments(path)

    expect(scrubbed).toMatch(/^\/[a-z]+(\/[a-z]+)?\/:redacted$/)
    expect(scrubbed.startsWith(path.slice(0, path.lastIndexOf('/') + 1))).toBe(true)
  })

  it.each([
    ['a 31-digit hex value', `/x/${HEX_64.slice(0, 31)}`],
    ['a short slug', '/articles/short-slug'],
    [
      'a long hyphenated lowercase slug',
      '/articles/how-to-rotate-a-signing-key-without-downtime-2024'
    ],
    ['a word-like segment', '/accounts/organizationadministration'],
    ['a JWT lookalike without the header prefix', '/x/abc.def.ghi'],
    ['a numeric id, which the id rule owns', '/users/123'],
    ['a UUID, which is an identifier', '/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736'],
    ['an upper-case UUID', '/users/4BF92F35-77B3-4DA6-A3CE-929D0E0E4736'],
    ['a dated path', '/reports/2024/11/13'],
    ['a text with an at sign that is not an address', '/tags/@team'],
    ['the root', '/'],
    ['an empty string', '']
  ])('leaves %s as it is', (_name, path) => {
    expect(scrubSecretSegments(path)).toBe(path)
  })

  it('reads a segment that is not valid percent-encoding as it was written', () => {
    expect(scrubSecretSegments(`/x/${HEX_64}%E0%A4%A`)).toBe('/x/:redacted')
    expect(scrubSecretSegments('/x/%E0%A4%A@example.com')).toBe('/x/:redacted')
    expect(scrubSecretSegments('/x/100%/y')).toBe('/x/100%/y')
  })

  it('replaces a segment a host pattern matches, including after a decode', () => {
    expect(scrubSecretSegments('/pay/tok_live_4242', [/^tok_/])).toBe('/pay/:redacted')
    expect(scrubSecretSegments('/pay/tok%5Flive', [/^tok_/])).toBe('/pay/:redacted')
    expect(scrubSecretSegments('/pay/other', [/^tok_/])).toBe('/pay/other')
  })

  it('gives the same answer on every call for a pattern with the global flag', () => {
    const pattern = /^tok_/g

    expect(scrubSecretSegments('/pay/tok_a', [pattern])).toBe('/pay/:redacted')
    expect(scrubSecretSegments('/pay/tok_a', [pattern])).toBe('/pay/:redacted')
    expect(pattern.lastIndex).toBe(0)
  })

  it('replaces every credential segment of a path, not only the first', () => {
    expect(scrubSecretSegments(`/a/${HEX_64}/b/${JWT}`)).toBe('/a/:redacted/b/:redacted')
  })
})

describe('normalizeUrl, with a credential in the path', () => {
  it('scrubs the credential before the id rules, so its leading digits are not an id', () => {
    expect(normalizeUrl(`/auth/reset/${HEX_64.replace(/^./, '7')}`)).toBe('/auth/reset/:redacted')
  })

  it('applies the host patterns and still strips the query', () => {
    expect(normalizeUrl('/pay/tok_live_1/orders/5?x=1', [/^tok_/])).toBe(
      '/pay/:redacted/orders/:id'
    )
  })
})

describe('secretPathSegments', () => {
  it('returns each credential segment once, as the request wrote it', () => {
    expect(
      secretPathSegments(`/a/${HEX_64}/b/${HEX_64}/c/someone%40example.com?t=${HEX_64}`)
    ).toEqual([HEX_64, 'someone%40example.com'])
  })

  it('returns nothing for a path without one', () => {
    expect(secretPathSegments('/users/123')).toEqual([])
  })
})

describe('withoutRequestSecrets, on a path', () => {
  it('replaces the credential segment in a not-found message and cuts the query', () => {
    expect(
      withoutRequestSecrets(`Cannot GET /auth/reset/${HEX_64}?x=1`, [], `/auth/reset/${HEX_64}?x=1`)
    ).toBe('Cannot GET /auth/reset/:redacted')
  })

  it('finds the credential in either URL of a mounted request', () => {
    expect(
      withoutRequestSecrets(`Cannot GET /api/r/${HEX_64}`, [], `/api/r/${HEX_64}`, `/r/${HEX_64}`)
    ).toBe('Cannot GET /api/r/:redacted')
  })

  it('leaves a text that does not carry the credential as it is', () => {
    expect(withoutRequestSecrets('Cannot GET /x', [], `/x/${HEX_64}`)).toBe('Cannot GET /x')
  })
})

describe('withoutRequestSecretsIfText', () => {
  it('returns a value that is not text unchanged', () => {
    const value = { a: 1 }

    expect(withoutRequestSecretsIfText(value, [], '/x')).toBe(value)
    expect(withoutRequestSecretsIfText(undefined, [], '/x')).toBeUndefined()
  })

  it('cleans a text', () => {
    expect(withoutRequestSecretsIfText(`GET /x/${HEX_64}`, [], `/x/${HEX_64}`)).toBe(
      'GET /x/:redacted'
    )
  })
})

describe('scrubSecretSegments, the edges of the detector', () => {
  it.each([
    ['a hex token with a file extension', `/download/${HEX_64}.pdf`],
    ['a base64url token with a file extension', `/verify/${TOKEN}.json`],
    ['a standard-base64 token with padding', `/verify/${TOKEN}==`],
    ['a standard-base64 token with a plus sign', `/verify/${TOKEN.slice(0, 20)}+${TOKEN.slice(20)}`]
  ])('replaces %s', (_name, path) => {
    expect(scrubSecretSegments(path)).toMatch(/^\/[a-z]+\/:redacted$/)
  })

  it.each([
    ['a letters-only token', '/reset/abcdefghijklmnopqrstuvwxyzABCDEF'],
    [
      'a long camelCase name, which no rule can tell from a token',
      '/rpc/getAllUsersWithPermissionsAndRoles'
    ],
    ['a hex token behind an underscore prefix', `/reset/rst_${HEX_64.slice(0, 32)}`],
    ['a hex token behind a hyphen prefix', `/reset/reset-${HEX_64.slice(0, 32)}`],
    ['a hex token between two words', `/reset/tok_${HEX_64.slice(0, 32)}_live`]
  ])('replaces %s', (_name, path) => {
    expect(scrubSecretSegments(path)).toMatch(/^\/[a-z]+\/:redacted$/)
  })

  it.each([
    ['a long snake_case name', '/reports/monthly_active_users_by_region_summary'],
    ['a long file name', '/files/quarterly-report-final-version-2024.pdf']
  ])('keeps %s, which is a name and not a token', (_name, path) => {
    expect(scrubSecretSegments(path)).toBe(path)
  })

  it('tests an email segment in linear time, whatever the dots and at signs', () => {
    const hostile = `/x/a@${'.'.repeat(16_000)}@`
    const started = Date.now()

    scrubSecretSegments(hostile)
    secretPathSegments(hostile)

    expect(Date.now() - started).toBeLessThan(100)
  })

  it('still reads an email address with several dots in its domain', () => {
    expect(scrubSecretSegments('/u/first.last@mail.example.co.uk')).toBe('/u/:redacted')
  })
})
