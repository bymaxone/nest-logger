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
   * Locks the canonical count to the documented composition (27 common
   * fields × 4 depths + 5 absolute paths = 113). A drift breaks consumer
   * dashboards that count redacted fields.
   */
  'should match the derived length 27 × 4 + 5 = 113', () => {
    const expected = REDACT_COMMON_FIELDS.length * 4 + REDACT_ABSOLUTE_PATHS.length
    expect(DEFAULT_REDACT_PATHS.length).toBe(expected)
    expect(DEFAULT_REDACT_PATHS.length).toBeGreaterThanOrEqual(113)
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
