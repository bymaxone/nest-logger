/**
 * Pins `createNameRedactor`'s `errorOnlyNames`: names censored inside an `Error` written as data,
 * in its own fields and its chain of causes at any depth, and not outside it. Driven directly
 * on the redactor, with no Pino.
 *
 * Layer: server, utils, tests.
 */
import { createNameRedactor } from './redact-by-name.util'

const CENSOR = '[REDACTED]'
const redact = (names: string[], covered: string[] = []) =>
  createNameRedactor(covered, CENSOR, ['err'], undefined, undefined, names)

describe('createNameRedactor with errorOnlyNames', () => {
  it('censors the names in the own fields of an Error and leaves them elsewhere', () => {
    const error = Object.assign(new Error('boom'), { password: 'in-error' })

    const out = redact(['password'])({ error, plain: { password: 'in-plain' } }, true) as {
      error: Record<string, unknown>
      plain: Record<string, unknown>
    }

    expect(out.error['password']).toBe(CENSOR)
    expect(out.error['message']).toBe('boom')
    expect(out.plain['password']).toBe('in-plain')
  })

  it('reaches into an object held by an Error and into its causes at any depth', () => {
    const deepest = Object.assign(new Error('d3'), { token: 'T3' })
    const middle = Object.assign(new Error('d2', { cause: deepest }), { token: 'T2' })
    const head = Object.assign(new Error('d1', { cause: middle }), {
      response: { headers: { token: 'T1' }, body: { note: 'kept' } }
    })

    const out = redact(['token'])({ head }, true) as { head: any }

    expect(out.head.response.headers.token).toBe(CENSOR)
    expect(out.head.response.body.note).toBe('kept')
    expect(out.head.cause.token).toBe(CENSOR)
    expect(out.head.cause.cause.token).toBe(CENSOR)
  })

  it('matches the names case-insensitively inside an Error', () => {
    const error = Object.assign(new Error('x'), { Authorization: 'bearer abc' })

    const out = redact(['authorization'])({ error }, true) as { error: Record<string, unknown> }

    expect(out.error['Authorization']).toBe(CENSOR)
  })

  it('is no different from the names it covers everywhere, when both are given', () => {
    const error = Object.assign(new Error('x'), { password: 'p' })

    const out = redact(['password'], ['password'])({ error, other: { password: 'q' } }, true) as {
      error: Record<string, unknown>
      other: Record<string, unknown>
    }

    expect(out.error['password']).toBe(CENSOR)
    expect(out.other['password']).toBe(CENSOR)
  })

  it('counts the containers of the Error against the one budget of the call', () => {
    const error = Object.assign(new Error('x'), { a: { b: { c: { d: { note: 'deep' } } } } })
    const small = createNameRedactor([], CENSOR, ['err'], 3, undefined, ['password'])
    const large = createNameRedactor([], CENSOR, ['err'], 100, undefined, ['password'])

    expect(JSON.stringify(small({ error }, true))).not.toContain('deep')
    expect(JSON.stringify(large({ error }, true))).toContain('deep')
  })
})

describe('the clone of an Error outside the record', () => {
  it('accepts an assignment in strict mode, for a data property the original froze and an accessor with no setter', () => {
    const error = Object.assign(new Error('x'), { frozen: 'v' })
    Object.defineProperty(error, 'getterOnly', { get: () => 'g', enumerable: false })
    Object.freeze(error)
    const clone = createNameRedactor(['frozen'], CENSOR)(error) as Record<string, unknown>

    expect(() => {
      'use strict'
      clone['frozen'] = 'changed'
      clone['getterOnly'] = 'changed'
    }).not.toThrow()
    expect(clone['getterOnly']).toBe('g')
  })
})
