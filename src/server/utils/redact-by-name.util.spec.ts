/**
 * Verifies createNameRedactor's walk: primitives passing through, sensitive keys censored at depth
 * and inside arrays, the traversal ceiling, copying rather than mutating or sharing the input, and
 * circular and shared references.
 *
 * Layer: server/utils, tests.
 */
import {
  REDACT_CIRCULAR,
  REDACT_DEPTH_EXCEEDED,
  REDACT_MAX_TRAVERSAL_DEPTH,
  createNameRedactor
} from './redact-by-name.util'

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
})
