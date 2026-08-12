import {
  REDACT_CIRCULAR,
  REDACT_DEPTH_EXCEEDED,
  REDACT_MAX_TRAVERSAL_DEPTH,
  createNameRedactor
} from './redact-by-name.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

const CENSOR = '[REDACTED]'
const redact = createNameRedactor(
  ['password', 'authorization', 'set-cookie', 'x-api-key', 'accessToken'],
  CENSOR
)

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
   * REGRESSION — arrays are indexed by NUMBER, not iterated. `for...of` runs the
   * array's `Symbol.iterator`, which a caller can override, while
   * `JSON.stringify` reads `length` and numeric indices. An iterator that never
   * returns `done` hung the walk — a loop that does not end cannot be caught by
   * the never-throw guard — and one yielding values unrelated to the indices made
   * the walk inspect something the array does not hold.
   */
  'should index arrays numerically rather than run their iterator', () => {
    const hostile = [{ password: 'SECRET' }]
    Object.defineProperty(hostile, Symbol.iterator, {
      value: function* (): Generator<unknown> {
        for (;;) {
          yield { decoy: 1 }
        }
      }
    })

    // Terminates, and censors the element the array actually holds rather than
    // the fiction the iterator was yielding.
    expect(JSON.stringify(redact({ list: hostile }))).toBe(`{"list":[{"password":"${CENSOR}"}]}`)
  })

  it(/*
   * An empty array must stay empty — the copy starts from `[]` and the loop never
   * runs, so nothing else may end up in it.
   */
  'should render an empty array as an empty array', () => {
    expect(JSON.stringify(redact({ list: [] }))).toBe('{"list":[]}')
  })

  it(/*
   * Holes must serialize exactly as the native serializer renders them, which is
   * the other half of reading the way `JSON.stringify` reads.
   */
  'should render a sparse array the same as JSON.stringify does', () => {
    const withInnerHoles: unknown[] = [1]
    withInnerHoles[3] = 2
    expect(JSON.stringify(redact({ s: withInnerHoles }))).toBe(
      JSON.stringify({ s: withInnerHoles })
    )

    // TRAILING holes are the case that pins the pre-sized copy: nothing writes
    // those indices, so only the constructor's length carries them through.
    const withTrailingHoles: unknown[] = [1]
    withTrailingHoles.length = 4
    expect(JSON.stringify(redact({ s: withTrailingHoles }))).toBe('{"s":[1,null,null,null]}')
    expect(JSON.stringify(redact({ s: withTrailingHoles }))).toBe(
      JSON.stringify({ s: withTrailingHoles })
    )
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
   * The ceiling bounds RECURSION, so it applies to containers, not to leaves: a
   * primitive one level PAST the limit is emitted rather than replaced by the
   * sentinel. That is deliberate — its key was compared against the sensitive set
   * by the parent at the limit, the last container the walk inspected, so it has
   * already been through the matcher and dropping it would only destroy
   * legitimate data. Asserted here because the prose claim ("deeper values are
   * dropped") read as unconditional and was reported as a hole in the ceiling.
   */
  'should emit a primitive past the ceiling but still censor it by key', () => {
    // The container sits exactly AT the limit, so it is walked; its primitive
    // children land one level past it and are returned as-is.
    const atLimit = { plain: 'PLAIN-LEAF', password: 'SECRET' }
    const serialized = JSON.stringify(redact(nest(REDACT_MAX_TRAVERSAL_DEPTH, atLimit)))
    expect(serialized).toContain('PLAIN-LEAF')
    expect(serialized).not.toContain(REDACT_DEPTH_EXCEEDED)
    // …and the matcher still governs them: the parent AT the limit checks the key.
    expect(serialized).not.toContain('SECRET')
    expect(serialized).toContain(CENSOR)
  })

  it(/*
   * A clean record round-trips to an equal — but NOT identical — value. Returning
   * it by reference was the allocation-free fast path, and it was traded away
   * deliberately: it left any accessor in the subtree to be evaluated a second
   * time by `JSON.stringify`, which a stateful getter can answer differently.
   * Everything is snapshot now, so the output is what was inspected.
   */
  'should snapshot a clean record into an equal copy', () => {
    const input = { a: 1, nested: { b: [1, 2, { c: 3 }] } }
    const result = redact(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })

  it(/*
   * REGRESSION — the reason the reference fast path had to go. A getter on a
   * NON-sensitive key answered clean to the walk and dirty to the serializer,
   * and the clean answer was what got inspected while the dirty one was what got
   * written. The record must now carry the inspected value.
   */
  'should not let a stateful getter differ between walk and serialization', () => {
    let reads = 0
    const input = {
      get payload(): unknown {
        reads += 1
        return reads === 1 ? { ok: 1 } : { password: 'SECRET' }
      }
    }

    const serialized = JSON.stringify(redact(input))

    expect(serialized).toBe('{"payload":{"ok":1}}')
    expect(serialized).not.toContain('SECRET')
  })

  it(/*
   * The other half of the snapshot rule: the caller's object must NEVER be mutated.
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
   * Untouched siblings are copied too, not shared. That is the cost of snapshotting
   * — pinned here so the trade-off is visible rather than rediscovered.
   */
  'should copy untouched branches rather than share them', () => {
    const untouched = { big: 'payload' }
    const input = { untouched, secrets: { password: 's' } }
    const result = redact(input) as Record<string, unknown>
    expect(result['untouched']).toEqual(untouched)
    expect(result['untouched']).not.toBe(untouched)
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
   * An Error with no own enumerable properties is still snapshot — the empty-key
   * fast path was removed because a Proxy can answer `[]` to `Object.keys` and
   * expose a property when Pino serializes the reference afterwards. The clone
   * must remain an Error and keep its message and stack.
   */
  'should snapshot an Error with no own properties, keeping it an Error', () => {
    const err = new Error('boom')
    const result = redact({ err }) as Record<string, Error>
    const cloned = result['err'] as Error

    expect(cloned).not.toBe(err)
    expect(cloned).toBeInstanceOf(Error)
    expect(cloned.message).toBe('boom')
    expect(cloned.stack).toBe(err.stack)
  })

  it(/*
   * REGRESSION — the empty-key fast path returned the ORIGINAL object, which a
   * stateful Proxy exploits: answer no keys to the walk, then expose an
   * enumerable secret when Pino serializes the reference it was handed back.
   */
  'should snapshot an object that reports no keys during the walk', () => {
    let reads = 0
    const target: Record<string, unknown> = { password: 'SECRET' }
    const sneaky = new Proxy(target, {
      ownKeys(inner): ArrayLike<string | symbol> {
        reads += 1
        return reads === 1 ? [] : Reflect.ownKeys(inner)
      }
    })

    const serialized = JSON.stringify(redact({ payload: sneaky }))

    expect(serialized).toBe('{"payload":{}}')
    expect(serialized).not.toContain('SECRET')
  })

  it(/*
   * REGRESSION — an Error carrying a sensitive own enumerable property used to be
   * skipped entirely, so `{ failure: err }` (any key without a Pino serializer)
   * reached the sink with the value in clear. It must now be censored — and the
   * copy must STILL be an Error, because Pino's `err` serializer keys off the
   * instance, and `message` / `stack` are own but NON-enumerable so a plain
   * spread would silently drop them.
   */
  'should redact an Error while keeping it an Error', () => {
    const err = Object.assign(new Error('boom'), { password: 'SECRET', code: 'E_X' })
    const result = redact({ err }) as Record<string, Error & Record<string, unknown>>
    const redacted = result['err'] as Error & Record<string, unknown>

    expect(redacted).not.toBe(err)
    expect(redacted).toBeInstanceOf(Error)
    expect(redacted.message).toBe('boom')
    expect(redacted.stack).toBe(err.stack)
    expect(redacted.stack).toContain('Error: boom')
    expect(redacted['password']).toBe(CENSOR)
    expect(redacted['code']).toBe('E_X')
    // The caller's error is untouched.
    expect(err.password).toBe('SECRET')
  })

  it(/*
   * An error can reach the logger without a string stack — `Error.captureStackTrace`
   * was suppressed, `stackTraceLimit` is 0, or the value came off the wire. The
   * clone must simply carry no stack rather than pinning `undefined` as one.
   */
  'should redact a stackless Error without inventing a stack', () => {
    const err = Object.assign(new Error('boom'), { password: 'SECRET' })
    Reflect.deleteProperty(err, 'stack')

    const redacted = (redact({ err }) as Record<string, Error & Record<string, unknown>>)['err']

    expect(redacted).toBeInstanceOf(Error)
    expect(redacted?.message).toBe('boom')
    expect(redacted?.['password']).toBe(CENSOR)
    // No own `stack` is fabricated: the clone must not gain a property the
    // original never had.
    expect(Object.hasOwn(redacted as object, 'stack')).toBe(false)
  })

  it(/*
   * A real Error keeps its stack NON-enumerable, so `JSON.stringify` omits it.
   * The clone must match: an enumerable stack would push the whole trace into
   * every serialized entry that carries a redacted error.
   */
  'should keep the cloned stack non-enumerable', () => {
    const err = Object.assign(new Error('boom'), { password: 'SECRET' })
    const redacted = (redact({ err }) as Record<string, Error>)['err'] as Error

    expect(redacted.stack).toBe(err.stack)
    expect(JSON.stringify(redacted)).not.toContain('Error: boom')
    expect(JSON.parse(JSON.stringify(redacted))).toEqual({ password: CENSOR })
  })

  it(/*
   * REGRESSION — `JSON.stringify` applies a callable `toJSON` to a FUNCTION
   * object too: the spec runs that step BEFORE the "callable serializes to
   * undefined" rule. Treating every non-object as a primitive therefore let a
   * function carrying a `toJSON` emit its synthesized payload with nothing
   * having inspected it.
   */
  'should redact what a callable value synthesizes through toJSON', () => {
    const callable = Object.assign(() => undefined, {
      toJSON: (): unknown => ({ password: 'SECRET' })
    })
    expect(JSON.stringify(redact({ payload: callable }))).toBe(
      `{"payload":{"password":"${CENSOR}"}}`
    )
  })

  it(/*
   * The converse: an ordinary function has no `toJSON`, and `JSON.stringify`
   * OMITS it. It must be handed back untouched — walking it would replace it with
   * a plain object and emit `{}` where the field used to disappear.
   */
  'should leave an ordinary function to be omitted by serialization', () => {
    expect(JSON.stringify(redact({ handler: (): void => undefined, id: 'a1' }))).toBe('{"id":"a1"}')
  })

  it(/*
   * `toJSON` is only special when it is CALLABLE. A plain data property that
   * happens to be named `toJSON` must not be invoked — treating it as a method
   * would throw and collapse the whole record into the failure envelope.
   */
  'should ignore a non-callable toJSON property', () => {
    const result = redact({ payload: { toJSON: 'not-a-function', password: 'SECRET' } })
    expect(JSON.stringify(result)).toBe(
      `{"payload":{"toJSON":"not-a-function","password":"${CENSOR}"}}`
    )
  })

  it(/*
   * REGRESSION — a value whose `toJSON()` SYNTHESIZES a sensitive field was
   * skipped by the walk and then serialized by `JSON.stringify` through that very
   * method, emitting the secret. The walk must inspect the method's output.
   */
  'should redact what toJSON synthesizes', () => {
    const result = redact({ token: { toJSON: (): unknown => ({ password: 'SECRET' }) } })
    expect(JSON.stringify(result)).toBe(`{"token":{"password":"${CENSOR}"}}`)
  })

  it(/*
   * REGRESSION — a `toJSON` can RENAME the field it exposes, carrying the value
   * around the matcher. Only the OUTPUT was walked, so the source key `password`
   * was never seen and the secret was emitted under `value`. A source that
   * carries a sensitive own key no longer has its method trusted.
   */
  'should censor a value whose toJSON renames a sensitive source field', () => {
    const renaming = {
      password: 'SECRET',
      toJSON(): unknown {
        return { value: this.password }
      }
    }
    expect(JSON.stringify(redact({ creds: renaming }))).toBe(`{"creds":"${CENSOR}"}`)
  })

  it(/*
   * The fail-closed check reads the SOURCE's own key names, so it fires even when
   * the method omits the field correctly. That over-redacts, deliberately: the
   * alternative — invoking `toJSON` against a sanitized copy, as the leak report
   * proposed — throws on every method that reads an internal slot rather than an
   * own property (`Date.prototype.toJSON.call({ ...date })` is
   * `toISOString is not a function`), trading a narrow leak for a crash on the
   * common case.
   */
  'should censor a sensitive-bearing source even when toJSON omits the field', () => {
    const careful = {
      password: 'SECRET',
      id: 'u_1',
      toJSON(): unknown {
        return { id: this.id }
      }
    }
    expect(JSON.stringify(redact({ user: careful }))).toBe(`{"user":"${CENSOR}"}`)
  })

  it(/*
   * The converse guard: a source with NO sensitive own key keeps its `toJSON`
   * honoured. Without this the check would swallow every `Date` / `Decimal` /
   * Luxon value in a payload that merely sits near a secret.
   */
  'should honour toJSON when the source carries no sensitive key', () => {
    const measure = {
      units: 3,
      toJSON: (): unknown => ({ units: 3 })
    }
    expect(JSON.stringify(redact({ measure }))).toBe('{"measure":{"units":3}}')
  })

  it(/*
   * Values whose JSON form comes from `toJSON` (Date, Decimal, Luxon, Prisma
   * types) must not be flattened to their own properties — the walk would
   * otherwise change what reaches the sink.
   */
  'should serialize toJSON-bearing values and leave binary views untouched', () => {
    const when = new Date('2020-01-01T00:00:00.000Z')
    const buf = Buffer.from('hi')
    const result = redact({ when, buf }) as Record<string, unknown>
    // The `toJSON` result is substituted rather than the object passed through:
    // returning the original would let `JSON.stringify` call the method again.
    // The emitted JSON is identical either way.
    expect(result['when']).toBe('2020-01-01T00:00:00.000Z')
    expect(JSON.stringify(result['when'])).toBe(JSON.stringify(when))
    // A pristine `Buffer` keeps the fast path: its JSON form comes from a
    // PROTOTYPE `toJSON` that cannot carry a caller's key.
    expect(result['buf']).toBe(buf)
  })

  it(/*
   * REGRESSION — `ArrayBuffer.isView` alone was too wide a fast path. It also
   * matched views a caller had extended, and three shapes leaked straight through
   * both redaction hooks. Each is asserted against what `JSON.stringify` produces
   * natively, so the walk cannot drift from the serializer.
   */
  'should inspect binary views a caller has extended', () => {
    const withOwnToJson = Object.assign(Buffer.from('hi'), {
      toJSON: (): unknown => ({ password: 'SECRET' })
    })
    const typedArray = Object.assign(new Uint8Array([1, 2]), { password: 'SECRET' })
    const dataView = Object.assign(new DataView(new ArrayBuffer(2)), { password: 'SECRET' })

    expect(JSON.stringify(redact({ b: withOwnToJson }))).toBe(`{"b":{"password":"${CENSOR}"}}`)
    expect(JSON.stringify(redact({ u: typedArray }))).toBe(
      `{"u":{"0":1,"1":2,"password":"${CENSOR}"}}`
    )
    expect(JSON.stringify(redact({ d: dataView }))).toBe(`{"d":{"password":"${CENSOR}"}}`)
  })

  it(/*
   * REGRESSION — a shape test on the fast path was not enough. Checking "is a
   * view AND has no OWN toJSON" still admitted a SUBCLASS that defines one on its
   * own prototype, which is neither own nor canonical. The check is now an
   * identity comparison against `Buffer.prototype.toJSON` itself, the one
   * function known to produce a `{ type, data }` output that cannot carry a
   * caller's key.
   */
  'should inspect a view subclass that overrides toJSON', () => {
    class SecretView extends Uint8Array {
      toJSON(): unknown {
        return { password: 'SECRET' }
      }
    }

    expect(JSON.stringify(redact({ v: new SecretView([1, 2]) }))).toBe(
      `{"v":{"password":"${CENSOR}"}}`
    )
  })

  it(/*
   * The fast path must still hold for a real `Buffer`, by REFERENCE — that is
   * what keeps a binary payload from being recursed over byte by byte.
   */
  'should return a pristine Buffer by reference', () => {
    const buf = Buffer.from('hi')
    expect((redact({ buf }) as Record<string, unknown>)['buf']).toBe(buf)
  })

  it(/*
   * A pristine view must still serialize exactly as the native serializer renders
   * it — the narrowing must not change what an ordinary binary payload looks like.
   */
  'should render pristine binary views exactly as JSON.stringify does', () => {
    const pristine = { b: Buffer.from('hi'), u: new Uint8Array([1, 2]) }
    expect(JSON.stringify(redact(pristine))).toBe(JSON.stringify(pristine))
  })

  it(/*
   * A `Date` has no own enumerable keys, so skipping it is indistinguishable
   * from walking it — which makes it a weak assertion. A `toJSON`-bearing value
   * that DOES carry own properties (a Decimal, a Luxon DateTime, a Prisma type)
   * is the real case: walking it would strip the `toJSON` on the copy and change
   * what reaches the sink from a scalar into an object.
   *
   * Its own properties are deliberately NON-sensitive here. A sensitive one
   * changes the outcome — the method stops being trusted and the whole value is
   * censored — which is its own pair of cases above; mixing the two into one
   * fixture asserted the wrong rule.
   */
  'should not flatten a toJSON-bearing value that carries own properties', () => {
    const money = {
      units: 1299,
      currency: 'BRL',
      toJSON(): string {
        return '12.99'
      }
    }
    const result = redact({ amount: money }) as Record<string, unknown>
    // Its own properties are never inspected — the method decides the form — and
    // the serialized output is unchanged.
    expect(result['amount']).toBe('12.99')
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
   * REGRESSION — `Reflect.defineProperty` reports failure by RETURNING `false`,
   * it does not throw. An `Error` carrying a non-configurable enumerable secret
   * keeps that descriptor through the clone, so writing the censor silently
   * no-opped and the raw value survived into the log. A censor that cannot be
   * written is a failed redaction, and a failed redaction must fail closed.
   */
  'should fail closed when the censor cannot be written', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'password', {
      value: 'SECRET',
      enumerable: true,
      writable: false,
      configurable: false
    })

    const result = redact({ err }) as Record<string, unknown>

    expect(result['_redactionFailed']).toBe(true)
    expect(result['_logKey']).toBe(RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED)
    expect(JSON.stringify(result)).not.toContain('SECRET')
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
   * REGRESSION — matching is case-INSENSITIVE. HTTP header names are
   * case-insensitive by spec, and only INBOUND Node headers arrive lower-cased;
   * a hand-built or outbound bag routinely carries `Authorization` / `Cookie` /
   * `X-API-Key`, and a case-sensitive set left every one of them in clear
   * despite the documented header coverage.
   */
  'should match field names case-insensitively', () => {
    const result = redact({
      Authorization: 'Bearer SECRET',
      'X-API-KEY': 'SECRET',
      Password: 'SECRET',
      password: 'SECRET',
      userName: 'kept'
    }) as Record<string, unknown>

    expect(result['Authorization']).toBe(CENSOR)
    expect(result['X-API-KEY']).toBe(CENSOR)
    expect(result['Password']).toBe(CENSOR)
    expect(result['password']).toBe(CENSOR)
    expect(result['userName']).toBe('kept')
  })

  it(/*
   * REGRESSION — `JSON.stringify` gives `toJSON` precedence over array
   * serialization, so the array branch must not run first: an array whose
   * `toJSON()` synthesizes a secret was walked as an ordinary array (finding
   * nothing in its elements) and then emitted the secret during serialization.
   */
  'should redact what an array-with-toJSON synthesizes', () => {
    const list = Object.assign([], { toJSON: (): unknown => ({ accessToken: 'SECRET' }) })
    const result = redact({ list })
    expect(JSON.stringify(result)).toBe(`{"list":{"accessToken":"${CENSOR}"}}`)
  })

  it(/*
   * An empty name set must be a pure pass-through by reference — the shape a
   * consumer gets with `shouldDisableDefaultRedact`.
   */
  'should pass everything through when the name set is empty', () => {
    const none = createNameRedactor([], CENSOR)
    const input = { password: 'kept' }
    expect(none(input)).toEqual(input)
  })
})
