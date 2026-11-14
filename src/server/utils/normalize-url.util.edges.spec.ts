/**
 * Covers the secret-segment helpers of normalize-url.util at their edges: an empty segment is left
 * alone, a token followed by a file extension is replaced, a dot-led hex token is replaced, and
 * segments made of pattern characters are replaced in a message.
 * Layer: server/utils, tests.
 */
import {
  scrubSecretSegments,
  secretPathSegments,
  withoutRequestSecrets
} from './normalize-url.util'

const TOKEN = 'Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZkdISUo'

describe('the empty segment', () => {
  it('is never read as a credential, whatever a host pattern says of an empty string', () => {
    const matchesEmpty = [/^$/]

    expect(scrubSecretSegments('/a//b', matchesEmpty)).toBe('/a//b')
    expect(secretPathSegments('/a//b', matchesEmpty)).toEqual([])
    expect(withoutRequestSecrets('Cannot GET /a//b', matchesEmpty, '/a//b')).toBe(
      'Cannot GET /a//b'
    )
  })
})

describe('the file extension after a token', () => {
  it('is read when it is at most eight characters, so the token does not reach the output', () => {
    const out = scrubSecretSegments(`/download/${TOKEN}.abcdefgh`)

    expect(out).toBe('/download/:redacted')
    expect(out).not.toContain(TOKEN)
  })

  it('does not hide the token when it is longer, because the token part is judged on its own', () => {
    expect(scrubSecretSegments(`/download/${TOKEN}.abcdefghi`)).toBe('/download/:redacted')
    expect(scrubSecretSegments(`/download/${TOKEN}.abcdefghijklmnop`)).toBe('/download/:redacted')
  })

  it('is not made up where there is none: a last character that is not a dot is not an extension', () => {
    expect(scrubSecretSegments(`/x/${TOKEN}!`)).toBe(`/x/${TOKEN}!`)
  })

  it('leaves a hex token that starts with a dot out of the output as well', () => {
    const hex = 'a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a'

    const out = scrubSecretSegments(`/x/.${hex}`)

    expect(out).toBe('/x/:redacted')
    expect(out).not.toContain(hex)
  })
})

describe('the text a message is cleaned of', () => {
  it('replaces a segment whose characters a pattern would read as special', () => {
    const url = '/unsubscribe/first.last+tag@example.co.uk'
    const text = `Cannot GET ${url}`

    const out = withoutRequestSecrets(text, [], url)

    expect(out).toBe('Cannot GET /unsubscribe/:redacted')
    expect(out).not.toContain('first.last')
    expect(out).not.toContain('example.co.uk')
  })

  it('replaces a host-matched segment made of pattern characters, once, wherever it sits', () => {
    const url = '/pay/tok_(a)+[b]*{1}$|^/tail'

    const out = withoutRequestSecrets(`Cannot GET ${url} and ${url}`, [/^tok_/], url)

    expect(out).toBe('Cannot GET /pay/:redacted/tail and /pay/:redacted/tail')
    expect(out).not.toContain('tok_')
  })
})
