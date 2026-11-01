/**
 * Pins how the name walk treats an `Error` it cannot read: the one unreadable node degrades and
 * its siblings survive, while a hostile value that is not an `Error` still fails the whole record.
 *
 * Layer: server/utils, tests. Kept apart from the walk's main spec so neither file grows past the
 * size limit.
 */
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

import { createNameRedactor } from './redact-by-name.util'

const CENSOR = '[REDACTED]'
const redact = createNameRedactor(['password', 'accessToken'], CENSOR)

/** An `Error` whose own enumerable `detail` getter throws when read. */
function withThrowingGetter(extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error('boom'), extra)
  Object.defineProperty(error, 'detail', {
    enumerable: true,
    get(): never {
      throw new Error('getter exploded')
    }
  })
  return error
}

/** A Proxy over an `Error` whose own-key enumeration throws. */
function withThrowingOwnKeys(extra: Record<string, unknown> = {}): Error {
  return new Proxy(Object.assign(new Error('boom'), extra), {
    ownKeys(): never {
      throw new Error('ownKeys exploded')
    }
  })
}

/** An `Error` whose `stack` getter throws. */
function withThrowingStack(extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error('boom'), extra)
  Object.defineProperty(error, 'stack', {
    get(): never {
      throw new Error('stack exploded')
    }
  })
  return error
}

/** An `Error` whose `message` getter throws. */
function withThrowingMessage(extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error('boom'), extra)
  Object.defineProperty(error, 'message', {
    get(): never {
      throw new Error('message exploded')
    }
  })
  return error
}

describe('createNameRedactor — an Error that cannot be read', () => {
  it.each([
    ['an own getter that throws', withThrowingGetter],
    ['an ownKeys trap that throws', withThrowingOwnKeys],
    ['a stack getter that throws', withThrowingStack],
    ['a message getter that throws', withThrowingMessage]
  ])('keeps the record and degrades only the error node for %s', (_label, makeError) => {
    /*
     * One unreadable Error must not cost the record its other fields. The walk degrades that
     * node to the sanitized form the `err` serializer would have produced, and the siblings
     * (`logKey`, the metadata) come through exactly as for a readable error.
     */
    const record = { logKey: 'PAYMENT_FAILED', userId: 'u1', paymentId: 'p1', err: makeError() }

    const out = redact(record, true) as Record<string, unknown>

    expect(out).not.toHaveProperty('_redactionFailed')
    expect(out).toMatchObject({ logKey: 'PAYMENT_FAILED', userId: 'u1', paymentId: 'p1' })
    expect(out['err']).toBeDefined()
    expect(out['err']).toMatchObject({ name: expect.any(String), message: expect.any(String) })
  })

  it(/*
   * Marks the node, so an entry whose error lost fields is never mistaken for a complete one.
   */
  'marks an error node whose own fields were not read', () => {
    const out = redact({ logKey: 'K', err: withThrowingGetter({ code: 'E1' }) }, true) as {
      err: Record<string, unknown>
    }

    expect(out.err).toMatchObject({ name: 'Error', message: 'boom', _errorFieldsIncomplete: true })
    expect(out.err).not.toHaveProperty('code')
  })

  it(/*
   * The node does not have to be at the top: an Error nested in the metadata, or as a `cause`,
   * degrades on its own and the record survives.
   */
  'degrades an unreadable Error nested inside the metadata', () => {
    const out = redact(
      { logKey: 'K', meta: { inner: withThrowingOwnKeys(), kept: 'yes' } },
      true
    ) as { meta: Record<string, unknown> }

    expect(out).not.toHaveProperty('_redactionFailed')
    expect(out.meta['kept']).toBe('yes')
    expect(out.meta['inner']).toMatchObject({ _errorFieldsIncomplete: true })
  })

  it.each([
    [
      'a readable password next to a throwing getter',
      (): Error => withThrowingGetter({ password: 's3cret-one' }),
      's3cret-one'
    ],
    [
      'a readable password with a hostile message getter',
      (): Error => withThrowingMessage({ password: 's3cret-two' }),
      's3cret-two'
    ],
    [
      'a readable password with a hostile stack getter',
      (): Error => withThrowingStack({ password: 's3cret-three' }),
      's3cret-three'
    ],
    [
      'a readable access token with a throwing ownKeys trap',
      (): Error => withThrowingOwnKeys({ accessToken: 's3cret-four' }),
      's3cret-four'
    ]
  ])('never lets a secret through for %s', (_label, makeError, secret) => {
    /*
     * The degraded node goes through the walk again, so a field the sanitizer could still copy
     * is censored by name, and a field it could not read is never copied at all. Whichever
     * happens, the clear value must appear nowhere in the serialized record.
     */
    const out = redact({ logKey: 'K', err: makeError() }, true)

    expect(JSON.stringify(out)).not.toContain(secret)
    expect(out).not.toHaveProperty('_redactionFailed')
  })

  it(/*
   * A stack that cannot be read costs the node its stack, not its other own fields: the
   * sanitized node carries the readable fields and the walk censors the sensitive one.
   */
  'censors a readable own field of an error whose stack could not be read', () => {
    const out = redact(
      { logKey: 'K', err: withThrowingStack({ password: 'clear', code: 'E1' }) },
      true
    ) as { err: Record<string, unknown> }

    expect(out.err).toMatchObject({ code: 'E1', password: CENSOR, _errorFieldsIncomplete: true })
  })

  it(/*
   * The control: an Error that reads fine is walked as before and keeps the shape the `err`
   * serializer relies on, an Error instance with its message and stack.
   */
  'leaves a readable Error exactly as before', () => {
    const error = Object.assign(new Error('boom'), { code: 'E1', password: 'clear' })

    const out = redact({ logKey: 'K', err: error }, true) as { err: Error }

    expect(out.err).toBeInstanceOf(Error)
    expect(out.err.message).toBe('boom')
    expect(out.err).toMatchObject({ code: 'E1', password: CENSOR })
    expect(out.err).not.toHaveProperty('_errorFieldsIncomplete')
  })

  it.each([
    [
      'a plain object with a throwing getter',
      (): unknown => ({
        get x(): never {
          throw new Error('x')
        }
      })
    ],
    [
      'a Proxy that is not an Error',
      (): unknown =>
        new Proxy(
          {},
          {
            ownKeys(): never {
              throw new Error('ownKeys exploded')
            }
          }
        )
    ]
  ])('still fails the whole record for %s', (_label, makeValue) => {
    /*
     * Only an Error node is isolated. A hostile value that is not an Error cannot be proven
     * safe and is not something the sanitizer reads, so the record keeps failing closed, and
     * LOGGER_REDACTION_FAILED keeps its documented meaning.
     */
    const out = redact({ logKey: 'K', other: makeValue() }, true)

    expect(out).toEqual({
      _redactionFailed: true,
      _logKey: RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
    })
  })
})
