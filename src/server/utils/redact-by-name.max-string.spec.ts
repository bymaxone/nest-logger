/**
 * Pins what the redaction walk does with a string longer than `maxStringLength`: the exact length
 * of what it writes at the limit and one either side, a surrogate pair that straddles the limit, a
 * string at any depth, and what it leaves alone (a key, a value that is not text, a censored value
 * and everything inside an `Error`), read on the redactor's own result.
 *
 * Layer: server/utils, tests.
 */
import { TEXT_TRUNCATED } from './bounded-text.util'
import { createNameRedactor } from './redact-by-name.util'

const LIMIT = 64

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** A redactor that cuts text at `limit` characters; `undefined` leaves the option off. */
function redactorAt(limit: number | undefined, serializedKeys?: readonly string[]) {
  return createNameRedactor(
    ['password'],
    '[REDACTED]',
    serializedKeys,
    undefined,
    undefined,
    undefined,
    undefined,
    limit
  )
}

/** The value written for `text` under the metadata key `field`. */
function cut(text: string, limit: number | undefined = LIMIT): unknown {
  const record = redactorAt(limit)({ field: text }, true) as { field: unknown }
  return record.field
}

/** The value written for `text` when the option is not given. */
function writtenWithOptionOff(text: string): unknown {
  const record = redactorAt(undefined)({ field: text }, true) as { field: unknown }
  return record.field
}

describe('maxStringLength: the length of what is written', () => {
  /*
   * The limit counts the characters kept, and the marker comes after them: a text of `limit`
   * characters is written whole, and one character more is cut to `limit` characters followed by
   * the marker, so what is written is `limit` plus the marker's length.
   */
  it('writes a text of one character under the limit, as it is', () => {
    const text = 'a'.repeat(LIMIT - 1)

    expect(cut(text)).toBe(text)
  })

  it('writes a text of exactly the limit, as it is', () => {
    const text = 'a'.repeat(LIMIT)

    expect(cut(text)).toBe(text)
  })

  it('cuts a text of one character over the limit to the limit and the marker', () => {
    const written = cut('a'.repeat(LIMIT + 1)) as string

    expect(written).toBe('a'.repeat(LIMIT) + TEXT_TRUNCATED)
    expect(written).toHaveLength(LIMIT + TEXT_TRUNCATED.length)
  })

  it('cuts a much longer text to the same length', () => {
    expect(cut('b'.repeat(1_000_000))).toBe('b'.repeat(LIMIT) + TEXT_TRUNCATED)
  })

  it('leaves the text whole when the option is off', () => {
    const text = 'c'.repeat(5000)

    expect(writtenWithOptionOff(text)).toBe(text)
  })
})

describe('maxStringLength: a surrogate pair at the limit', () => {
  /*
   * A cut between the two halves of a pair would leave an unpaired high surrogate, which is not
   * well-formed text, so the half is dropped and the text is cut one character earlier.
   */
  it('drops the first half of a pair that straddles the limit', () => {
    const text = 'a'.repeat(LIMIT - 1) + '😀' + 'tail'

    expect(cut(text)).toBe('a'.repeat(LIMIT - 1) + TEXT_TRUNCATED)
  })

  it('keeps a pair that ends exactly at the limit', () => {
    const text = 'a'.repeat(LIMIT - 2) + '😀' + 'tail'

    expect(cut(text)).toBe('a'.repeat(LIMIT - 2) + '😀' + TEXT_TRUNCATED)
  })

  it('writes well-formed text for a text made only of pairs', () => {
    const written = cut('😀'.repeat(200)) as string

    expect(written).toBe('😀'.repeat(LIMIT / 2) + TEXT_TRUNCATED)
    expect(LONE_SURROGATE.test(written)).toBe(false)
  })
})

describe('maxStringLength: where it applies', () => {
  const long = 'x'.repeat(LIMIT + 10)
  const cutLong = 'x'.repeat(LIMIT) + TEXT_TRUNCATED

  it('cuts a string at any depth, in an object and in an array', () => {
    const record = redactorAt(LIMIT)(
      { a: { b: { c: long } }, list: [long, 'short', { d: long }] },
      true
    ) as { a: { b: { c: string } }; list: [string, string, { d: string }] }

    expect(record.a.b.c).toBe(cutLong)
    expect(record.list).toEqual([cutLong, 'short', { d: cutLong }])
  })

  it('writes a censored value as the censor, not as a cut text', () => {
    const record = redactorAt(LIMIT)({ password: long }, true) as { password: string }

    expect(record.password).toBe('[REDACTED]')
  })

  it('leaves a key, a number, a boolean and null as they are', () => {
    const key = 'k'.repeat(LIMIT + 10)

    const record = redactorAt(LIMIT)({ [key]: 1, flag: true, none: null, n: 12345678 }, true)

    expect(record).toEqual({ [key]: 1, flag: true, none: null, n: 12345678 })
  })
})

describe('maxStringLength: what an Error keeps', () => {
  /*
   * A message and a stack are text of the Error the logger writes whole, and nobody should lose
   * the stack of an error to a limit meant for metadata, so what is inside an Error is not cut,
   * however the Error is written.
   */
  function errorWithLongText(): Error {
    const error = Object.assign(new Error('m'.repeat(LIMIT + 20)), {
      detail: 'd'.repeat(LIMIT + 20)
    })
    error.stack = `Error: m\n${'    at frame (file.js:1:1)\n'.repeat(20)}`
    return error
  }

  it('keeps the stack, the message and an own field of an Error held as an instance', () => {
    const error = errorWithLongText()

    const record = redactorAt(LIMIT)({ inner: error }, true) as {
      inner: Error & { detail: string }
    }

    expect(record.inner.stack).toBe(error.stack)
    expect(record.inner.message).toBe(error.message)
    expect(record.inner.detail).toBe('d'.repeat(LIMIT + 20))
    expect((error.stack ?? '').length).toBeGreaterThan(LIMIT)
  })

  it('keeps them for an Error written as data', () => {
    const error = errorWithLongText()

    const record = redactorAt(LIMIT, ['err'])({ ctx: { inner: error } }, true) as {
      ctx: { inner: { stack: string; message: string; detail: string } }
    }

    expect(record.ctx.inner.stack).toBe(error.stack)
    expect(record.ctx.inner.message).toBe(error.message)
    expect(record.ctx.inner.detail).toBe('d'.repeat(LIMIT + 20))
  })

  it('keeps them for the Error under a serialized key, and cuts a sibling string', () => {
    const error = errorWithLongText()

    const record = redactorAt(LIMIT, ['err'])(
      { err: error, note: 'n'.repeat(LIMIT + 5) },
      true
    ) as {
      err: { stack: string }
      note: string
    }

    expect(record.err.stack).toBe(error.stack)
    expect(record.note).toBe('n'.repeat(LIMIT) + TEXT_TRUNCATED)
  })
})

describe('maxStringLength: what identifies the entry and what a serializer reads', () => {
  const long = 'x'.repeat(LIMIT + 10)
  const longKey = 'K'.repeat(LIMIT + 20)

  /*
   * `event.name` is derived from the `logKey` of the record, and a key grouped on by an operator is
   * an identifier: cutting it would split one event into as many names as it has lengths.
   */
  it('never cuts the logKey of the record, and cuts a sibling string', () => {
    const record = redactorAt(LIMIT)({ logKey: longKey, note: long }, true) as {
      logKey: string
      note: string
    }

    expect(record.logKey).toBe(longKey)
    expect(record.note).toBe('x'.repeat(LIMIT) + TEXT_TRUNCATED)
  })

  it('cuts a field named logKey that is not at the root of the record', () => {
    const record = redactorAt(LIMIT)({ nested: { logKey: longKey } }, true) as {
      nested: { logKey: string }
    }

    expect(record.nested.logKey).toBe('K'.repeat(LIMIT) + TEXT_TRUNCATED)
  })

  /*
   * What sits under a key that has a serializer is what the serializer reads, and what it returns
   * is bounded by `maxEntrySizeBytes`, so the text of an error-like object under `err`, which is
   * not an `Error` instance, is not cut either.
   */
  it('leaves what sits under a serialized key whole, and cuts the strings around it', () => {
    const redact = redactorAt(LIMIT, ['err', 'order'])

    const record = redact(
      {
        err: { name: 'Error', message: long, stack: long },
        order: { notes: [long] },
        note: long
      },
      true
    ) as { err: { message: string; stack: string }; order: { notes: string[] }; note: string }

    expect(record.err).toEqual({ name: 'Error', message: long, stack: long })
    expect(record.order.notes).toEqual([long])
    expect(record.note).toBe('x'.repeat(LIMIT) + TEXT_TRUNCATED)
  })
})
