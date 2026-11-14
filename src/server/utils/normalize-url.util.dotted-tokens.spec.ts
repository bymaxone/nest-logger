/**
 * Pins how a path segment that holds a dot is judged: each dot-separated part is tested the way an
 * undotted segment is, so a dotted credential (an OAuth access token, a PASETO, an opaque token made
 * of dotted parts) is written as `:redacted` and an ordinary dotted value is left alone.
 */
import { scrubSecretSegments, secretPathSegments } from './normalize-url.util'

/** A base64url-looking run of `length` characters that is not a slug, a UUID or hex. */
function opaque(length: number, seed = 'Qx7'): string {
  const alphabet = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-'
  let out = seed
  for (let i = seed.length; i < length; i += 1) out += alphabet[(i * 7 + 3) % alphabet.length]
  return out
}

describe('a dotted credential in a path segment', () => {
  it.each([
    ['a Google OAuth access token', `ya29.${opaque(120)}`],
    ['a PASETO v4 local token', `v4.local.${opaque(80)}`],
    ['a PASETO v2 public token', `v2.public.${opaque(90)}`],
    [
      'an opaque token of three dotted parts',
      `${opaque(40)}.${opaque(40, 'Zk9')}.${opaque(43, 'Lm2')}`
    ],
    ['a long part after a short one', `AbCd.${opaque(64)}`]
  ])('writes %s as :redacted', (_name, segment) => {
    expect(scrubSecretSegments(`/auth/reset/${segment}`)).toBe('/auth/reset/:redacted')
    expect(secretPathSegments(`/auth/reset/${segment}?x=1`)).toEqual([segment])
  })

  it('does not rely on the segment being the last one in the path', () => {
    const token = `ya29.${opaque(120)}`

    expect(scrubSecretSegments(`/oauth/${token}/callback`)).toBe('/oauth/:redacted/callback')
  })
})

describe('an ordinary dotted value in a path segment', () => {
  it.each([
    'john.doe',
    'john.doe.smith',
    'report.v2.pdf',
    'report.final.v2.pdf',
    'v1.2.3',
    '1.0.0-beta.1',
    '2026.11.14',
    'example.com',
    'api.example.com',
    'my-long-subdomain-name-for-the-tenant.example.com',
    'quarterly-financial-report-2026-q3.final.pdf',
    '550e8400-e29b-41d4-a716-446655440000.pdf',
    '550e8400-e29b-41d4-a716-446655440000.v2.json',
    'invoice_2026_11_000123.pdf',
    'IMG_20261114_093000.jpg',
    'Quarterly.Financial.Report.2026.Q3.xlsx',
    'com.bymax.app.mobile',
    'org.apache.commons.lang3.StringUtils',
    'jquery-3.7.1.min.js',
    'bundle.8f3a9c1d.chunk.js',
    'main.3f9a2b7c1d4e5f60.js',
    'user.profile.settings.notifications.email',
    'release-notes-v1.4.17.md',
    'cache.key.tenant_42.user_9001',
    'a1b2c3d4e5f6.png',
    'ULID01ARZ3NDEKTSV4RRFFQ69G5FAV.json'
  ])('leaves %s as it is', (segment) => {
    expect(scrubSecretSegments(`/files/${segment}`)).toBe(`/files/${segment}`)
    expect(secretPathSegments(`/files/${segment}`)).toEqual([])
  })

  it('keeps a part of 31 characters, one short of the token length', () => {
    const segment = `name.${opaque(31)}`

    expect(scrubSecretSegments(`/files/${segment}`)).toBe(`/files/${segment}`)
  })

  it('redacts a part of exactly 32 characters', () => {
    const segment = `name.${opaque(32)}`

    expect(scrubSecretSegments(`/files/${segment}`)).toBe('/files/:redacted')
  })
})

describe('a JWT whose parts are short, followed by a file extension', () => {
  /** A three-part JWT too short for any part to be a token on its own. */
  const JWT = 'eyJhbGciOiJub25lIn0.e30.c2ln'

  it('is written as :redacted when the extension is at most eight characters', () => {
    expect(scrubSecretSegments(`/download/${JWT}.abcdefgh`)).toBe('/download/:redacted')
    expect(scrubSecretSegments(`/download/${JWT}.pdf`)).toBe('/download/:redacted')
  })

  it('is left as it is when the suffix is nine characters or more, because the segment is then a name', () => {
    expect(scrubSecretSegments(`/download/${JWT}.abcdefghi`)).toBe(`/download/${JWT}.abcdefghi`)
  })

  it('is written as :redacted without any extension', () => {
    expect(scrubSecretSegments(`/download/${JWT}`)).toBe('/download/:redacted')
  })
})
