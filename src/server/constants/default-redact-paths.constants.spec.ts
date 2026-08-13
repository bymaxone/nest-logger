import {
  DEFAULT_REDACT_PATHS,
  REDACT_ABSOLUTE_PATHS,
  REDACT_COMMON_FIELDS,
  depth
} from './default-redact-paths.constants'

describe('depth helper', () => {
  it(/*
   * The expansion must produce exactly four levels of wildcard prefixes —
   * the public contract relied on by `DEFAULT_REDACT_PATHS` and the count
   * derived in this spec.
   */
  'should return four wildcard variants for a given leaf field', () => {
    const result = depth('foo')
    expect(result).toEqual(['*.foo', '*.*.foo', '*.*.*.foo', '*.*.*.*.foo'])
  })

  it(/*
   * Re-checks with a realistic field name to guard against the helper being
   * accidentally hard-coded to `foo` in a future regression.
   */
  'should expand the password field across depths 1..4', () => {
    expect(depth('password')).toEqual([
      '*.password',
      '*.*.password',
      '*.*.*.password',
      '*.*.*.*.password'
    ])
  })
})

describe('DEFAULT_REDACT_PATHS', () => {
  it(/*
   * Locks the composition: every common field at the record root plus its four
   * depth wildcards, then the absolute header paths. The count is DERIVED, not
   * fixed — the list is append-only, so it may only grow. The root entries exist
   * so a sensitive field spread into the record root as caller metadata is
   * redacted, not only one nested a level deep.
   */
  'should match the derived length fields × 5 + absolute paths', () => {
    const expected = REDACT_COMMON_FIELDS.length * 5 + REDACT_ABSOLUTE_PATHS.length
    expect(DEFAULT_REDACT_PATHS.length).toBe(expected)
    // Append-only floor: the set as shipped in 1.1.0. It may grow, never shrink.
    expect(DEFAULT_REDACT_PATHS.length).toBeGreaterThanOrEqual(140)
  })

  it(/*
   * The reason the root entries exist: `emitStructured` spreads caller metadata
   * at the record root, so a bare `password` must be a redact path in its own
   * right, not only `*.password`. This is the exact gap that let the library's
   * own documented `info(key, msg, userId, { password })` call log in clear.
   */
  'should redact the bare (root-level) name of every common field', () => {
    for (const field of REDACT_COMMON_FIELDS) {
      expect(DEFAULT_REDACT_PATHS).toContain(field)
    }
  })

  it(/*
   * Spot-checks that key categories (passwords, tokens, BR documents, HTTP
   * headers, PII) are all represented — guards against a future refactor
   * accidentally removing a category.
   */
  'should cover passwords, tokens, secrets, BR documents, HTTP headers and email', () => {
    expect(DEFAULT_REDACT_PATHS).toContain('*.password')
    expect(DEFAULT_REDACT_PATHS).toContain('*.accessToken')
    expect(DEFAULT_REDACT_PATHS).toContain('*.secret')
    expect(DEFAULT_REDACT_PATHS).toContain('*.clientSecret')
    expect(DEFAULT_REDACT_PATHS).toContain('*.cpf')
    expect(DEFAULT_REDACT_PATHS).toContain('*.cnpj')
    expect(DEFAULT_REDACT_PATHS).toContain('*.email')
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.authorization')
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers["x-api-key"]')
    expect(DEFAULT_REDACT_PATHS).toContain('res.headers["set-cookie"]')
  })

  it(/*
   * REGRESSION — audit finding S-1. The credential-bearing header names were
   * present ONLY as the absolute paths `req.headers.*` / `res.headers.*`, so a
   * headers bag logged under any other key wrote the bearer token in clear.
   * They must now be first-class field names, which is what makes the name walk
   * catch them anywhere — and what expands them across the legacy depths too.
   */
  'should list every credential-bearing header as a bare field name', () => {
    for (const header of ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']) {
      expect(REDACT_COMMON_FIELDS).toContain(header)
      expect(DEFAULT_REDACT_PATHS).toContain(header)
      expect(DEFAULT_REDACT_PATHS).toContain(`*.${header}`)
    }
  })

  it(/*
   * `fast-redact` (the engine behind `pino.redact`) historically throws on
   * duplicate paths. The merged list must therefore stay unique.
   */
  'should contain no duplicate entries', () => {
    const unique = new Set(DEFAULT_REDACT_PATHS)
    expect(unique.size).toBe(DEFAULT_REDACT_PATHS.length)
  })

  it(/*
   * Every entry must be a non-empty string — protects against accidental
   * `undefined`/empty entries that would degenerate to a wildcard match.
   */
  'should expose only non-empty string entries', () => {
    for (const path of DEFAULT_REDACT_PATHS) {
      expect(typeof path).toBe('string')
      expect(path.length).toBeGreaterThan(0)
    }
  })
})
