/**
 * Pins the size-bounded serializer: it passes small, unmeasurable and boundary-sized values through and replaces over-limit ones with a truncation envelope measured in UTF-8 bytes.
 * Layer: server/utils, tests.
 */
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

import { createSizeBoundedSerializer } from './truncate-large-entries'

/** Identity serializer — lets the test drive the size logic directly. */
const identity = (input: unknown): unknown => input

describe('createSizeBoundedSerializer', () => {
  /*
   * A value under the byte ceiling must pass through completely untouched — the
   * wrapper must add zero overhead to normal-sized entries.
   */
  it('passes values under the limit through unchanged', () => {
    const serialize = createSizeBoundedSerializer(identity, 1_000)
    const value = { user: 'alice', plan: 'pro' }
    expect(serialize(value)).toEqual(value)
  })

  /*
   * A value over the byte ceiling must be replaced by the truncation envelope,
   * carrying the LOGGER_ENTRY_TRUNCATED reserved key, the original byte size, and
   * a bounded preview — so oversized payloads never flood the sink.
   */
  it('replaces over-limit values with a truncation envelope', () => {
    const serialize = createSizeBoundedSerializer(identity, 10)
    const value = { blob: 'x'.repeat(500) }

    const result = serialize(value)

    expect(result).toMatchObject({
      _truncated: true,
      _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED,
      _originalSize: Buffer.byteLength(JSON.stringify(value), 'utf-8')
    })
    const preview = (result as Record<string, unknown>)['_preview']
    expect(typeof preview).toBe('string')
    expect((preview as string).length).toBeLessThanOrEqual(200)
  })

  /*
   * The ceiling must be measured in UTF-8 BYTES, not characters: a multi-byte
   * string whose CHARACTER length is under the limit but whose BYTE length is
   * over it must still truncate (the wire format is UTF-8).
   */
  it('measures the ceiling in UTF-8 bytes, not characters', () => {
    // 'é' is 1 UTF-16 char but 2 UTF-8 bytes. JSON is `"é…é"` → 12 chars / 22 bytes.
    const value = 'é'.repeat(10)
    const json = JSON.stringify(value)
    expect(json.length).toBeLessThanOrEqual(15) // under the limit by character count
    expect(Buffer.byteLength(json, 'utf-8')).toBeGreaterThan(15) // over it by byte count

    const serialize = createSizeBoundedSerializer(identity, 15)
    expect(serialize(value)).toMatchObject({ _truncated: true })
  })

  /*
   * A serializer that produces `undefined` (JSON.stringify → undefined) must pass
   * through without throwing — there is nothing to measure or truncate.
   */
  it('passes an undefined serialization through without throwing', () => {
    const serialize = createSizeBoundedSerializer(() => undefined, 10)
    expect(serialize('ignored')).toBeUndefined()
  })

  /*
   * A serializer output with a reference to itself, or a BigInt, cannot be measured by a plain
   * JSON.stringify. It is measured with a replacer that stands in for the part JSON cannot write,
   * so a value that is over the ceiling is truncated like any other, and one that is under it is
   * returned as it is. Only a value that cannot be measured at all is replaced, with a size of -1.
   */
  describe('a value JSON.stringify cannot measure', () => {
    const cyclic = (payload: string): Record<string, unknown> => {
      const value: Record<string, unknown> = { payload }
      value['self'] = value
      return value
    }

    it('is truncated when its measured size is over the ceiling', () => {
      const serialize = createSizeBoundedSerializer(() => cyclic('x'.repeat(500)), 100)

      expect(serialize('ignored')).toMatchObject({
        _truncated: true,
        _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED
      })
    })

    /*
     * The size in the envelope is the size of the text Pino would write: every value is counted
     * as written, a primitive that appears twice is two primitives, and only a reference back to an
     * ancestor is a cycle. An exact size shows that the stack of ancestors is neither short nor long.
     */
    it('measures a mixed structure exactly, repeating primitives and nulls as they are written', () => {
      const value = {
        a: 'xy',
        b: 'xy',
        c: 1,
        d: 1,
        e: null,
        f: null,
        g: [1, 1, 'xy'],
        h: { i: 'xy' }
      }
      const serialize = createSizeBoundedSerializer(() => value, 1)

      const result = serialize('ignored') as Record<string, unknown>

      expect(result['_originalSize']).toBe(Buffer.byteLength(JSON.stringify(value), 'utf-8'))
    })

    it('measures a cycle as the text "[Circular]", with an exact size', () => {
      const value: Record<string, unknown> = { n: 1, payload: 'x'.repeat(40) }
      value['self'] = value
      const expected = JSON.stringify({ n: 1, payload: 'x'.repeat(40), self: '[Circular]' })
      const serialize = createSizeBoundedSerializer(() => value, 1)

      const result = serialize('ignored') as Record<string, unknown>

      expect(result['_originalSize']).toBe(Buffer.byteLength(expected, 'utf-8'))
      expect(result['_preview']).toBe(expected)
    })

    it('measures a cycle that closes after several levels, with an exact size', () => {
      const inner: Record<string, unknown> = { depth: 2 }
      const outer: Record<string, unknown> = { depth: 1, inner }
      inner['back'] = outer
      const expected = JSON.stringify({ depth: 1, inner: { depth: 2, back: '[Circular]' } })
      const serialize = createSizeBoundedSerializer(() => outer, 1)

      const result = serialize('ignored') as Record<string, unknown>

      expect(result['_preview']).toBe(expected)
    })

    it('is returned as it is when its measured size is under the ceiling', () => {
      const value = cyclic('small')
      const serialize = createSizeBoundedSerializer(() => value, 1000)

      expect(serialize('ignored')).toBe(value)
    })

    it('counts a repeated reference every time it is written, not once', () => {
      const shared = { payload: 'x'.repeat(300) }
      const serialize = createSizeBoundedSerializer(() => ({ a: shared, b: shared }), 400)

      expect(serialize('ignored')).toMatchObject({ _truncated: true })
    })

    it('measures a BigInt by its decimal digits', () => {
      const small = { n: 1n }
      const big = { text: 'x'.repeat(500), n: 12345678901234567890n }

      expect(createSizeBoundedSerializer(() => small, 100)('ignored')).toBe(small)
      expect(createSizeBoundedSerializer(() => big, 100)('ignored')).toMatchObject({
        _truncated: true
      })
    })

    it.each([
      [
        'a toJSON that throws',
        (): unknown => ({
          toJSON(): never {
            throw new Error('toJSON exploded')
          }
        })
      ],
      [
        'a getter that throws',
        (): unknown =>
          Object.defineProperty({}, 'boom', {
            enumerable: true,
            get(): never {
              throw new Error('getter exploded')
            }
          })
      ]
    ])('is replaced with a size of -1 when it has %s', (_label, make) => {
      const serialize = createSizeBoundedSerializer(make, 1000)

      expect(serialize('ignored')).toEqual({
        _truncated: true,
        _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED,
        _originalSize: -1,
        _preview: ''
      })
    })
  })

  /*
   * A value whose serialized size is EXACTLY the ceiling must pass through — the
   * comparison is strictly `> maxBytes`, not `>=`. Pins the boundary so an
   * off-by-one (`>` → `>=`) regression is caught.
   */
  it('passes a value exactly at the byte ceiling through unchanged', () => {
    const value = 'x'.repeat(10) // JSON.stringify → "xxxxxxxxxx" = 12 UTF-8 bytes
    const exactBytes = Buffer.byteLength(JSON.stringify(value), 'utf-8')
    expect(exactBytes).toBe(12)

    const serialize = createSizeBoundedSerializer(identity, exactBytes)
    expect(serialize(value)).toBe(value)
  })
})
