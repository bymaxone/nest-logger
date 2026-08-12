import {
  REDACT_CIRCULAR,
  REDACT_DEPTH_EXCEEDED,
  REDACT_MAX_TRAVERSAL_DEPTH,
  createNameRedactor
} from './redact-by-name.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

const CENSOR = '[REDACTED]'
const redact = createNameRedactor(['password', 'authorization', 'set-cookie'], CENSOR)

/** Build a `{ a: { a: { … { password } } } }` chain `levels` deep. */
function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = leaf
  for (let i = 0; i < levels; i++) {
    current = { a: current }
  }
  return current
}

/** Read the leaf of a `nest()` chain back out. */
function unnest(value: unknown, levels: number): Record<string, unknown> {
  let current = value as Record<string, unknown>
  for (let i = 0; i < levels; i++) {
    current = current['a'] as Record<string, unknown>
  }
  return current
}

describe('createNameRedactor', () => {
  it(/*
   * Primitives and null have no keys to match and must be returned untouched —
   * the walk's cheapest and most-travelled exit.
   */
  'should pass primitives and null through unchanged', () => {
    expect(redact(null)).toBeNull()
    expect(redact(42)).toBe(42)
    expect(redact('plain')).toBe('plain')
    expect(redact(undefined)).toBeUndefined()
  })

  it(/*
   * The core contract: a sensitive key is censored wherever it sits, and a
   * non-sensitive sibling at the same level is left alone.
   */
  'should censor a sensitive key and keep its siblings', () => {
    const result = redact({ password: 's', username: 'u' }) as Record<string, unknown>
    expect(result['password']).toBe(CENSOR)
    expect(result['username']).toBe('u')
  })

  it(/*
   * REGRESSION — audit finding S-1. `authorization` / `cookie` / `set-cookie`
   * were redacted ONLY at the absolute paths `req.headers.*` / `res.headers.*`,
   * so a headers bag logged under any other key wrote the bearer token in clear.
   * Name matching must catch it in any position.
   */
  'should censor auth headers in a bag logged outside req.headers', () => {
    const result = redact({
      headers: { authorization: 'Bearer SECRET', 'set-cookie': 'sid=SECRET' }
    }) as Record<string, Record<string, unknown>>
    expect(result['headers']?.['authorization']).toBe(CENSOR)
    expect(result['headers']?.['set-cookie']).toBe(CENSOR)
  })

  it(/*
   * REGRESSION — audit finding S-2. The wildcard path list stopped at four
   * levels, so anything nested deeper leaked silently. Depth 5 is the first
   * level the old engine could not reach; 20 and 50 prove there is no new
   * ceiling hiding behind it.
   */
  'should censor beyond the old four-level wildcard ceiling', () => {
    for (const levels of [5, 8, 20, 50]) {
      const result = redact(nest(levels, { password: 'SECRET' }))
      expect(unnest(result, levels)['password']).toBe(CENSOR)
    }
  })

  it(/*
   * Arrays are walked like any other container: an object inside one must be
   * redacted, and the result must still be an array (not an index-keyed object).
   */
  'should censor inside arrays and preserve array shape', () => {
    const result = redact({ users: [{ password: 's' }, { name: 'ok' }] }) as {
      users: Record<string, unknown>[]
    }
    expect(Array.isArray(result.users)).toBe(true)
    expect(result.users[0]?.['password']).toBe(CENSOR)
    expect(result.users[1]?.['name']).toBe('ok')
  })

  it(/*
   * Every changed element must land at its OWN index. With a single sensitive
   * element the write index is always 0, which hides an index-tracking bug — two
   * sensitive elements at different positions is the shape that exposes it.
   */
  'should censor every sensitive element at its own index', () => {
    const result = redact({
      users: [{ password: 'a' }, { safe: 1 }, { password: 'b' }, { password: 'c' }]
    }) as { users: Record<string, unknown>[] }
    expect(result.users.map((user) => user['password'])).toEqual([
      CENSOR,
      undefined,
      CENSOR,
      CENSOR
    ])
    expect(result.users[1]).toEqual({ safe: 1 })
    expect(result.users).toHaveLength(4)
  })

  it(/*
   * Arrays must be walked through the array branch, not fall through to the
   * object one: `{...['a','b']}` produces an index-keyed OBJECT, which serializes
   * as `{"0":"a"}` instead of `["a"]` and silently changes the shape every
   * downstream query depends on.
   */
  'should keep a redacted array serializing as an array', () => {
    const result = redact({ users: [{ password: 's' }] })
    expect(JSON.stringify(result)).toBe(`{"users":[{"password":"${CENSOR}"}]}`)
  })

  it(/*
   * Depth is counted per level of nesting inside arrays too, so an array chain
   * must hit the traversal ceiling exactly like an object chain.
   */
  'should apply the traversal ceiling through arrays', () => {
    let nested: unknown = { password: 'SECRET' }
    for (let i = 0; i < REDACT_MAX_TRAVERSAL_DEPTH + 5; i++) {
      nested = [nested]
    }
    const serialized = JSON.stringify(redact({ root: nested }))
    expect(serialized).not.toContain('SECRET')
    expect(serialized).toContain(REDACT_DEPTH_EXCEEDED)
  })

  it(/*
   * The ceiling is exclusive: a value sitting exactly AT the limit must still be
   * redacted, not dropped. An off-by-one here silently discards a whole subtree
   * of legitimate log data.
   */
  'should still redact at exactly the traversal ceiling', () => {
    // `nest(n)` places the leaf OBJECT at depth n, so `n = MAX` sits it exactly
    // on the limit — the one input that tells `depth > MAX` from `depth >= MAX`.
    // (A primitive is returned before the depth check, so only objects can trip it.)
    const result = redact(nest(REDACT_MAX_TRAVERSAL_DEPTH, { password: 'SECRET' }))
    const serialized = JSON.stringify(result)
    expect(serialized).toContain(CENSOR)
    expect(serialized).not.toContain(REDACT_DEPTH_EXCEEDED)
    expect(serialized).not.toContain('SECRET')
  })

  it(/*
   * Copy-on-write: a record with nothing to redact must come back by REFERENCE.
   * This is what keeps the clean path allocation-free, so it is asserted on
   * identity, not equality.
   */
  'should return the same reference when nothing is sensitive', () => {
    const input = { a: 1, nested: { b: [1, 2, { c: 3 }] } }
    expect(redact(input)).toBe(input)
    expect(redact(input.nested)).toBe(input.nested)
  })

  it(/*
   * The other half of copy-on-write: the caller's object must NEVER be mutated.
   * A redactor that scrubbed in place would corrupt the application state that
   * produced the log.
   */
  'should not mutate the input when it redacts', () => {
    const inner = { password: 'SECRET' }
    const input = { outer: inner }
    const result = redact(input) as { outer: Record<string, unknown> }
    expect(inner.password).toBe('SECRET')
    expect(input.outer).toBe(inner)
    expect(result.outer['password']).toBe(CENSOR)
    expect(result).not.toBe(input)
  })

  it(/*
   * Only the branch that changed is copied; untouched siblings stay shared, so
   * redacting one deep field does not clone the whole record.
   */
  'should share untouched branches with the original', () => {
    const untouched = { big: 'payload' }
    const input = { untouched, secrets: { password: 's' } }
    const result = redact(input) as Record<string, unknown>
    expect(result['untouched']).toBe(untouched)
  })

  it(/*
   * A cycle must terminate and must NOT be replaced by the original reference:
   * a copied ancestor holds censored values while the original still holds the
   * raw ones, so handing the original back would re-expose the secret through
   * the cycle.
   */
  'should replace a circular reference with the circular sentinel', () => {
    const node: Record<string, unknown> = { password: 'SECRET' }
    node['self'] = node
    const result = redact({ node }) as { node: Record<string, unknown> }
    expect(result.node['password']).toBe(CENSOR)
    expect(result.node['self']).toBe(REDACT_CIRCULAR)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it(/*
   * A shared (diamond) reference is not a cycle — it must be walked on both
   * branches rather than collapsing to the circular sentinel on the second.
   */
  'should redact a shared reference on every branch it appears', () => {
    const shared = { password: 'SECRET' }
    const result = redact({ left: shared, right: shared }) as Record<
      string,
      Record<string, unknown>
    >
    expect(result['left']?.['password']).toBe(CENSOR)
    expect(result['right']?.['password']).toBe(CENSOR)
  })

  it(/*
   * The stack guard fails CLOSED: past the traversal ceiling the value is
   * dropped, never passed through. A redactor that gave up and forwarded the
   * subtree would turn a depth bomb into a disclosure.
   */
  'should drop values nested past the traversal ceiling', () => {
    const levels = REDACT_MAX_TRAVERSAL_DEPTH + 5
    const result = redact(nest(levels, { password: 'SECRET' }))
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).toContain(REDACT_DEPTH_EXCEEDED)
  })

  it(/*
   * An `Error` is deliberately not descended into — copying it to a plain object
   * would break the instance Pino's `err` serializer keys off. The factory
   * redacts the serializer's OUTPUT instead; here we only pin that the instance
   * survives by reference.
   */
  'should leave an Error instance untouched', () => {
    const err = Object.assign(new Error('boom'), { password: 'SECRET' })
    const result = redact({ err }) as Record<string, unknown>
    expect(result['err']).toBe(err)
  })

  it(/*
   * Values whose JSON form comes from `toJSON` (Date, Decimal, Luxon, Prisma
   * types) must not be flattened to their own properties — the walk would
   * otherwise change what reaches the sink.
   */
  'should leave toJSON-bearing values and binary views untouched', () => {
    const when = new Date('2020-01-01T00:00:00.000Z')
    const buf = Buffer.from('hi')
    const result = redact({ when, buf }) as Record<string, unknown>
    expect(result['when']).toBe(when)
    expect(result['buf']).toBe(buf)
  })

  it(/*
   * A `Date` has no own enumerable keys, so skipping it is indistinguishable
   * from walking it — which makes it a weak assertion. A `toJSON`-bearing value
   * that DOES carry own properties (a Decimal, a Luxon DateTime, a Prisma type)
   * is the real case: walking it would strip the `toJSON` on the copy and change
   * what reaches the sink from a scalar into an object.
   */
  'should not flatten a toJSON-bearing value that carries own properties', () => {
    const money = {
      units: 1299,
      password: 'not-really-a-secret-here',
      toJSON(): string {
        return '12.99'
      }
    }
    const result = redact({ amount: money }) as Record<string, unknown>
    expect(result['amount']).toBe(money)
    expect(JSON.stringify(result)).toBe('{"amount":"12.99"}')
  })

  it(/*
   * A class instance has no `toJSON`, so it IS walked — and the copy is a plain
   * object carrying its own enumerable properties, which is byte-identical to
   * what `JSON.stringify` would have produced for the instance.
   */
  'should redact inside a class instance without changing its JSON form', () => {
    class Dto {
      readonly id = 'u1'
      readonly password = 'SECRET'
    }
    const result = redact({ dto: new Dto() })
    expect(JSON.stringify(result)).toBe(`{"dto":{"id":"u1","password":"${CENSOR}"}}`)
  })

  it(/*
   * A `__proto__` key must be stored as an ordinary own property on the copy,
   * never routed to `Object.prototype`'s accessor — otherwise redacting a
   * hostile payload would repoint the copy's prototype.
   */
  'should not pollute the prototype when copying a __proto__ key', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"password":"s"}') as object
    const result = redact(hostile) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(result['password']).toBe(CENSOR)
  })

  it(/*
   * Fail-closed: a value the walk cannot read (a throwing getter, a hostile
   * proxy) yields a marked, data-free envelope. Emitting the unredacted record
   * would be a leak; throwing would crash the request that produced the log.
   */
  'should degrade to a marked envelope when traversal throws', () => {
    const result = redact({
      nested: {
        get boom(): never {
          throw new Error('hostile getter')
        }
      }
    }) as Record<string, unknown>
    expect(result['_redactionFailed']).toBe(true)
    expect(result['_logKey']).toBe(RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED)
  })

  it(/*
   * The censor is configurable and must be used verbatim, so a consumer's
   * `redactCensor` reaches the walk rather than being hard-coded.
   */
  'should apply a custom censor', () => {
    const custom = createNameRedactor(['password'], '***')
    expect((custom({ password: 's' }) as Record<string, unknown>)['password']).toBe('***')
  })

  it(/*
   * Matching is case-sensitive, mirroring `fast-redact` — the semantics the
   * default set has always had. Node lower-cases inbound header names, so the
   * lower-case spelling is the one that can reach a log.
   */
  'should match field names case-sensitively', () => {
    const result = redact({ Password: 'kept', password: 's' }) as Record<string, unknown>
    expect(result['Password']).toBe('kept')
    expect(result['password']).toBe(CENSOR)
  })

  it(/*
   * An empty name set must be a pure pass-through by reference — the shape a
   * consumer gets with `shouldDisableDefaultRedact`.
   */
  'should pass everything through when the name set is empty', () => {
    const none = createNameRedactor([], CENSOR)
    const input = { password: 'kept' }
    expect(none(input)).toBe(input)
  })
})
