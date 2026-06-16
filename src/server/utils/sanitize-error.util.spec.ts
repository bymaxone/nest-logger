import { sanitizeError } from './sanitize-error.util'

describe('sanitizeError', () => {
  it(/*
   * A plain Error must serialize to name/message/stack. This is the baseline
   * shape every error log depends on.
   */
  'should serialize a plain Error to name, message, and stack', () => {
    const result = sanitizeError(new Error('boom'))
    expect(result.name).toBe('Error')
    expect(result.message).toBe('boom')
    expect(typeof result.stack).toBe('string')
    // A cause-less error must NOT gain a spurious `cause` field — pins the
    // `if (value.cause !== undefined)` guard against being forced true.
    expect(result).not.toHaveProperty('cause')
    expect(result).not.toHaveProperty('errors')
  })

  it(/*
   * Native subclasses must keep their own constructor name so error
   * dashboards can group by type (TypeError vs RangeError vs SyntaxError).
   */
  'should preserve the name of native Error subclasses', () => {
    expect(sanitizeError(new TypeError('bad arg')).name).toBe('TypeError')
    expect(sanitizeError(new RangeError('out of bounds')).name).toBe('RangeError')
    expect(sanitizeError(new SyntaxError('unexpected token')).name).toBe('SyntaxError')
  })

  it(/*
   * A cause chain within budget must be fully serialized so operators can read
   * the full failure story. Depth 2 is under the default budget of 3.
   */
  'should fully serialize a cause chain within the depth budget', () => {
    const error = new Error('outer', { cause: new Error('middle', { cause: new Error('inner') }) })
    expect(sanitizeError(error)).toMatchObject({
      name: 'Error',
      message: 'outer',
      cause: { message: 'middle', cause: { message: 'inner' } }
    })
  })

  it(/*
   * A cause chain deeper than the budget must be truncated with the marker so
   * a pathological (or malicious) chain cannot blow the stack or the log size.
   */
  'should truncate a cause chain beyond the depth budget', () => {
    const chainError = new Error('e1', {
      cause: new Error('e2', {
        cause: new Error('e3', { cause: new Error('e4', { cause: new Error('e5') }) })
      })
    })
    expect(sanitizeError(chainError)).toMatchObject({
      cause: { cause: { cause: { cause: { _truncated: true, _reason: 'cause-depth-exceeded' } } } }
    })
  })

  it(/*
   * A custom maxCauseDepth must be honored, truncating earlier than the
   * default. Exercises the options branch and an earlier truncation point.
   */
  'should honor a custom maxCauseDepth option', () => {
    const error = new Error('outer', { cause: new Error('inner', { cause: new Error('deepest') }) })
    expect(sanitizeError(error, { maxCauseDepth: 1 })).toMatchObject({
      cause: { message: 'inner', cause: { _truncated: true, _reason: 'cause-depth-exceeded' } }
    })
  })

  it(/*
   * AggregateError inner failures must each be serialized so a Promise.any /
   * Promise.allSettled rejection logs every underlying error.
   */
  'should serialize every AggregateError inner error', () => {
    const error = new AggregateError([new Error('a'), new Error('b'), new Error('c')], 'all failed')
    const result = sanitizeError(error)
    expect(result.name).toBe('AggregateError')
    expect(result.errors).toHaveLength(3)
    expect(result).toMatchObject({
      errors: [{ message: 'a' }, { message: 'b' }, { message: 'c' }]
    })
  })

  it(/*
   * AggregateError members past the depth budget must be truncated, not
   * walked — bounds aggregate fan-out the same way the cause chain is bounded.
   */
  'should truncate AggregateError members beyond the depth budget', () => {
    const error = new AggregateError([new Error('a')], 'failed')
    expect(sanitizeError(error, { maxCauseDepth: 0 }).errors).toEqual([
      { _truncated: true, _reason: 'cause-depth-exceeded' }
    ])
  })

  it(/*
   * The depth budget must keep counting THROUGH an aggregate member into its own
   * cause chain (aggregate descent increments depth, like cause descent does). A
   * member whose cause chain runs past the budget must truncate — pins the
   * `depth + 1` increment on the aggregate branch.
   */
  'should apply the depth budget to a cause chain inside an aggregate member', () => {
    const member = new Error('a', {
      cause: new Error('b', { cause: new Error('c', { cause: new Error('d') }) })
    })
    const result = sanitizeError(new AggregateError([member], 'agg'))
    expect(result.errors?.[0]).toMatchObject({
      message: 'a',
      cause: { message: 'b', cause: { message: 'c', cause: { _truncated: true } } }
    })
  })

  it(/*
   * An AggregateError WIDER than the cap must serialize the first
   * MAX_AGGREGATE_ERRORS (10) members and collapse the remainder into ONE width
   * marker recording how many were omitted — bounding O(N) fan-out work on the
   * error path (a Promise.any over thousands of rejections).
   */
  'should cap AggregateError width and record the omitted count', () => {
    const members = Array.from({ length: 13 }, (_, i) => new Error(`e${i}`))
    const result = sanitizeError(new AggregateError(members, 'many failures'))
    // 10 sanitized members + 1 width marker = 11 entries.
    expect(result.errors).toHaveLength(11)
    expect(result.errors?.[0]).toMatchObject({ message: 'e0' })
    expect(result.errors?.[10]).toEqual({
      _truncated: true,
      _reason: 'aggregate-width-exceeded',
      _omitted: 3
    })
  })

  it(/*
   * An AggregateError AT exactly the width cap must NOT gain a width marker —
   * pins the `aggregated.length > MAX_AGGREGATE_ERRORS` boundary against an
   * off-by-one (`>` → `>=`) regression.
   */
  'should not add a width marker at exactly the cap', () => {
    const members = Array.from({ length: 10 }, (_, i) => new Error(`e${i}`))
    const result = sanitizeError(new AggregateError(members, 'exactly ten'))
    expect(result.errors).toHaveLength(10)
    expect(result.errors?.[9]).toMatchObject({ message: 'e9' })
  })

  it(/*
   * A self-referential cause must collapse to the circular sentinel instead of
   * recursing forever. This is the canonical crash a naive serializer hits.
   */
  'should collapse a self-referential cause to the circular sentinel', () => {
    const error = new Error('loops')
    error.cause = error
    expect(() => sanitizeError(error)).not.toThrow()
    expect(sanitizeError(error).cause).toBe('[Circular]')
  })

  it(/*
   * A mutual cause cycle (A → B → A) must also terminate at the sentinel,
   * proving the WeakSet tracks every node, not just the root.
   */
  'should collapse a mutual cause cycle to the circular sentinel', () => {
    const a = new Error('a')
    const b = new Error('b')
    a.cause = b
    b.cause = a
    expect(sanitizeError(a)).toMatchObject({
      message: 'a',
      cause: { message: 'b', cause: '[Circular]' }
    })
  })

  it(/*
   * Non-error primitives must degrade to UnknownError with the stringified
   * value, never throw. Covers the most common "threw a non-Error" mistakes.
   */
  'should convert non-error inputs to UnknownError', () => {
    expect(sanitizeError(42)).toEqual({ name: 'UnknownError', message: '42' })
    expect(sanitizeError(null)).toEqual({ name: 'UnknownError', message: 'null' })
    expect(sanitizeError(undefined)).toEqual({ name: 'UnknownError', message: 'undefined' })
    expect(sanitizeError({ random: 'object' })).toEqual({
      name: 'UnknownError',
      message: '[object Object]'
    })
  })

  it(/*
   * None of the non-error inputs may throw — the never-throw contract is the
   * whole reason this util exists on the error path.
   */
  'should never throw on non-error inputs', () => {
    expect(() => sanitizeError(42)).not.toThrow()
    expect(() => sanitizeError(null)).not.toThrow()
    expect(() => sanitizeError(undefined)).not.toThrow()
    expect(() => sanitizeError(Symbol('s'))).not.toThrow()
  })

  it(/*
   * A non-object cause (a thrown string) must serialize as UnknownError under
   * `cause`, exercising the non-object branch of the child walker.
   */
  'should serialize a non-object cause as UnknownError', () => {
    const error = new Error('outer', { cause: 'root reason' })
    expect(sanitizeError(error).cause).toEqual({ name: 'UnknownError', message: 'root reason' })
  })

  it(/*
   * A null cause is distinct from an absent cause: it is present (!== undefined)
   * yet not an object, so it must serialize as UnknownError 'null'. Pins the
   * `value !== null` guard.
   */
  'should serialize a null cause as UnknownError', () => {
    const error = new Error('outer', { cause: null })
    expect(sanitizeError(error).cause).toEqual({ name: 'UnknownError', message: 'null' })
  })

  it(/*
   * node_modules/ frames must be stripped from the stack so logs surface app
   * code, not dependency noise. App frames must survive.
   */
  'should scrub node_modules frames from the stack', () => {
    const error = new Error('x')
    error.stack =
      'Error: x\n    at handler (/app/src/foo.ts:1:1)\n    at dep (/app/node_modules/pkg/i.js:2:2)'
    const result = sanitizeError(error)
    expect(result.stack).not.toContain('node_modules')
    expect(result.stack).toContain('/app/src/foo.ts')
    // The surviving app frames must stay newline-separated (not concatenated) —
    // pins the `.join('\n')` separator. Two app frames remain after scrubbing.
    expect(result.stack).toContain('\n')
    expect(result.stack?.split('\n')).toHaveLength(2)
  })

  it(/*
   * An error without a stack must omit the stack field entirely (not emit
   * `stack: undefined`). Pins the conditional-assignment branch.
   */
  'should omit the stack field when no stack is present', () => {
    const error = new Error('no stack')
    delete error.stack
    expect(sanitizeError(error)).not.toHaveProperty('stack')
  })

  it(/*
   * A hostile getter on the error must NOT crash serialization — it degrades to
   * SanitizeFailed. This is the last line of the never-throw defense.
   */
  'should degrade to SanitizeFailed when a getter throws', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('getter boom')
      }
    })
    expect(() => sanitizeError(error)).not.toThrow()
    expect(sanitizeError(error)).toEqual({
      name: 'SanitizeFailed',
      message: 'Failed to sanitize the thrown value'
    })
  })
})
