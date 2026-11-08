import { applyDefaults } from '../config/default-options'
import { resolveNameRedactor } from '../pino-factory'
import {
  DEFAULT_REDACT_PATHS,
  REDACT_ABSOLUTE_PATHS,
  REDACT_COMMON_FIELDS,
  depth
} from './default-redact-paths.constants'

/**
 * The sensitive field names as shipped. The list is append-only, so every name here stays; a name
 * may be added to the list without touching this one, and removing one fails the spec.
 */
const FLOOR_NAMES: readonly string[] = [
  'password',
  'passwordHash',
  'passwordConfirm',
  'newPassword',
  'oldPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'apiSecret',
  'mfaSecret',
  'mfaRecoveryCodes',
  'totpSecret',
  'cardNumber',
  'cardCvv',
  'cvv',
  'cvc',
  'cardExpiry',
  'cpf',
  'cnpj',
  'rg',
  'secret',
  'clientSecret',
  'signingSecret',
  'privateKey',
  'email',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token'
]

/** The absolute header paths as shipped, with the same append-only floor. */
const FLOOR_ABSOLUTE_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]'
]

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

describe('the append-only floor of the default redaction set', () => {
  it(/*
   * The whole table, not a sample: a name removed from the list is a field that silently stopped
   * being redacted, which no consumer would notice. Each name that was shipped must still be in it.
   */
  'keeps every sensitive field name that was shipped', () => {
    expect(REDACT_COMMON_FIELDS).toEqual(expect.arrayContaining([...FLOOR_NAMES]))
  })

  it('keeps every absolute header path that was shipped', () => {
    expect(REDACT_ABSOLUTE_PATHS).toEqual(expect.arrayContaining([...FLOOR_ABSOLUTE_PATHS]))
  })

  it('expands every shipped name at the record root and at depths 1 to 4 in the legacy set', () => {
    for (const name of FLOOR_NAMES) {
      expect(DEFAULT_REDACT_PATHS).toEqual(expect.arrayContaining([name, ...depth(name)]))
    }
    expect(DEFAULT_REDACT_PATHS).toEqual(expect.arrayContaining([...FLOOR_ABSOLUTE_PATHS]))
  })

  it.each(FLOOR_NAMES)(
    'censors %s at the record root and nested, with the defaults and no option',
    (name) => {
      const redact = resolveNameRedactor(
        applyDefaults({ service: { name: 'app', version: '1.0.0' } })
      )

      const written = JSON.stringify(
        redact({ [name]: 'LEAK', nested: { deep: { [name]: 'LEAK' } } })
      )

      expect(written).not.toContain('LEAK')
    }
  )
})
