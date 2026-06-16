import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

import { createSizeBoundedSerializer } from './truncate-large-entries'

/** Identity serializer — lets the test drive the size logic directly. */
const identity = (input: unknown): unknown => input

describe('createSizeBoundedSerializer', () => {
  it(/*
   * A value under the byte ceiling must pass through completely untouched — the
   * wrapper must add zero overhead to normal-sized entries.
   */
  'passes values under the limit through unchanged', () => {
    const serialize = createSizeBoundedSerializer(identity, 1_000)
    const value = { user: 'alice', plan: 'pro' }
    expect(serialize(value)).toEqual(value)
  })

  it(/*
   * A value over the byte ceiling must be replaced by the truncation envelope,
   * carrying the LOGGER_ENTRY_TRUNCATED reserved key, the original byte size, and
   * a bounded preview — so oversized payloads never flood the sink.
   */
  'replaces over-limit values with a truncation envelope', () => {
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

  it(/*
   * The ceiling must be measured in UTF-8 BYTES, not characters: a multi-byte
   * string whose CHARACTER length is under the limit but whose BYTE length is
   * over it must still truncate (the wire format is UTF-8).
   */
  'measures the ceiling in UTF-8 bytes, not characters', () => {
    // 'é' is 1 UTF-16 char but 2 UTF-8 bytes. JSON is `"é…é"` → 12 chars / 22 bytes.
    const value = 'é'.repeat(10)
    const json = JSON.stringify(value)
    expect(json.length).toBeLessThanOrEqual(15) // under the limit by character count
    expect(Buffer.byteLength(json, 'utf-8')).toBeGreaterThan(15) // over it by byte count

    const serialize = createSizeBoundedSerializer(identity, 15)
    expect(serialize(value)).toMatchObject({ _truncated: true })
  })

  it(/*
   * A serializer that produces `undefined` (JSON.stringify → undefined) must pass
   * through without throwing — there is nothing to measure or truncate.
   */
  'passes an undefined serialization through without throwing', () => {
    const serialize = createSizeBoundedSerializer(() => undefined, 10)
    expect(serialize('ignored')).toBeUndefined()
  })

  it(/*
   * A serializer output that JSON.stringify CANNOT measure (a circular reference,
   * or a hostile toJSON) must pass through without throwing — the logging path is
   * fail-soft and must never crash the caller. Covers the JSON.stringify try/catch.
   */
  'passes an unstringifiable (circular) value through without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const serialize = createSizeBoundedSerializer(() => circular, 10)
    expect(() => serialize('ignored')).not.toThrow()
    expect(serialize('ignored')).toBe(circular)
  })

  it(/*
   * A value whose serialized size is EXACTLY the ceiling must pass through — the
   * comparison is strictly `> maxBytes`, not `>=`. Pins the boundary so an
   * off-by-one (`>` → `>=`) regression is caught.
   */
  'passes a value exactly at the byte ceiling through unchanged', () => {
    const value = 'x'.repeat(10) // JSON.stringify → "xxxxxxxxxx" = 12 UTF-8 bytes
    const exactBytes = Buffer.byteLength(JSON.stringify(value), 'utf-8')
    expect(exactBytes).toBe(12)

    const serialize = createSizeBoundedSerializer(identity, exactBytes)
    expect(serialize(value)).toBe(value)
  })
})
