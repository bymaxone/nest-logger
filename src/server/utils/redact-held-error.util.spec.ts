/**
 * Pins what is written for a held `Error`: only what its `'safe'` form and what its `toJSON`
 * returns both write.
 *
 * Layer: server, utils.
 */
import { createOwnFieldPolicy } from './own-field-policy.util'
import { createNameRedactor, REDACT_MAX_TRAVERSAL_DEPTH } from './redact-by-name.util'
import { createPathHold } from './redact-path-state.util'

/** What is written for `{ u: error }`, held through `pan`, under a walk of `max` containers. */
function written(error: Error, output: (this: Error) => unknown, max = 1000): unknown {
  Object.defineProperty(error, 'inner', { value: { pan: 'x' }, enumerable: false })
  Object.defineProperty(error, 'toJSON', { value: output, configurable: true })
  const hold = createPathHold(['u.pan'], 1000, createOwnFieldPolicy('safe', ['tenant']))
  const redact = createNameRedactor(
    ['password'],
    '[X]',
    undefined,
    max,
    undefined,
    undefined,
    undefined,
    false,
    hold
  )
  const record = redact({ u: error }, true) as { u: unknown }
  return JSON.parse(JSON.stringify(record.u)) as unknown
}

const failed = (): Error =>
  Object.assign(new TypeError('failed'), { code: 'E1', tenant: 't1', config: 'c' })

describe('what is written for a held Error', () => {
  /* The head and the listed fields, with the values both forms have. */
  it('keeps what both forms write', () => {
    const stack = 'TypeError: failed\n    at run (/srv/app.js:1:1)'
    const error = Object.assign(failed(), { stack })
    const { message, name } = error
    const output = { type: name, name, message, stack, code: 'E1', tenant: 't1' }

    expect(written(error, () => output)).toEqual(output)
    expect(written(failed(), () => ({ code: 'E1' }))).toEqual({ code: 'E1' })
  })

  /* Both walks drop the frames of dependencies, so what is written is what 'safe' writes. */
  it('writes a stack as both forms shorten it', () => {
    const stack = `Error: failed${'\n    at run (/srv/node_modules/lib/index.js:1:1)'.repeat(12)}`
    const error = Object.assign(new Error('failed'), { stack })

    expect(written(error, () => ({ stack }))).toEqual({ stack: 'Error: failed' })
  })

  /* The names censored only inside an `Error` are censored in both forms. */
  it('writes no value under a name censored only inside an Error', () => {
    const error = new Error('failed')
    Object.defineProperty(error, 'inner', { value: { pan: 'x' } })
    Object.defineProperty(error, 'toJSON', { value: () => ({ message: 'failed' }) })
    const hold = createPathHold(['u.pan'], 1000, createOwnFieldPolicy('safe', []))
    const redact = createNameRedactor(
      ['password'],
      '[X]',
      undefined,
      1000,
      undefined,
      ['message'],
      undefined,
      false,
      hold
    )

    expect(JSON.stringify(redact({ u: error }, true))).toBe('{"u":{"message":"[X]"}}')
  })

  it('leaves out a key that is neither a part nor a listed field', () => {
    expect(written(failed(), () => ({ config: 'c', other: 'x' }))).toEqual({})
  })

  /* A value that is not the one the 'safe' form has may be another field, renamed. */
  it.each(['type', 'name', 'message', 'stack', 'code', 'tenant', 'status', 'cause', 'errors'])(
    'censors a %s the two forms do not share',
    (key) => {
      expect(written(failed(), () => ({ [key]: 'x' }))).toEqual({ [key]: '[X]' })
    }
  )

  it.each<readonly [string, unknown]>([
    ['an object for a value', { code: { a: 'E1' } }],
    ['a list for a value', { code: ['E1'] }],
    ['null for a value', { code: null }]
  ])('censors %s', (_label, output) => {
    expect(written(failed(), () => output)).toEqual({ code: '[X]' })
  })

  it('compares an object and a list member by member', () => {
    const cause = new Error('inner')
    const error = Object.assign(new Error('failed', { cause }), { errors: [cause] })
    const output = (): unknown => ({
      cause: { message: 'inner', stack: 'other' },
      errors: [{ message: 'inner' }, { message: 'extra' }]
    })

    expect(written(error, output)).toEqual({
      cause: { message: 'inner', stack: '[X]' },
      errors: [{ message: 'inner' }, '[X]']
    })
  })

  it('censors a member the safe form has no place for, even an empty one', () => {
    const error = Object.assign(new Error('failed'), { errors: [new Error('inner')] })
    const output = (): unknown => ({ errors: [{ message: 'inner' }, undefined] })

    expect(written(error, output)).toEqual({ errors: [{ message: 'inner' }, '[X]'] })
  })

  it.each<readonly [string, unknown]>([
    ['an object', { a: 1 }],
    ['null', null]
  ])('censors a list where the safe form has %s', (_label, value) => {
    const error = Object.assign(new Error('failed'), { code: value })

    expect(written(error, () => ({ code: ['x'] }))).toEqual({ code: '[X]' })
  })

  it('censors an object where the safe form has a list', () => {
    const error = Object.assign(new Error('failed'), { errors: [new Error('inner')] })

    expect(written(error, () => ({ errors: { message: 'inner' } }))).toEqual({ errors: '[X]' })
  })

  it.each<readonly [string, () => unknown]>([
    ['text', () => 'x'],
    ['null', () => null],
    ['nothing', () => undefined],
    ['a list', () => ['x']],
    ['another Error', () => new Error('x')],
    [
      'a throw',
      () => {
        throw new Error('no')
      }
    ]
  ])('is the censor for a toJSON that returns %s', (_label, output) => {
    expect(written(new Error('failed'), output)).toBe('[X]')
  })

  it('calls toJSON on the Error', () => {
    const output = function (this: Error): unknown {
      return { message: this.message }
    }

    expect(written(failed(), output)).toEqual({ message: 'failed' })
  })

  it('follows the toJSON of what a toJSON returns', () => {
    const output = (): unknown => ({ code: 'other', toJSON: () => ({ code: 'E1' }) })

    expect(written(failed(), output)).toEqual({ code: 'E1' })
  })

  /* The 'safe' form leaves an accessor out without running it. */
  it('runs no own accessor of the Error', () => {
    const get = jest.fn(() => 'x')
    const error = Object.defineProperty(new Error(), 'code', { get, enumerable: true })

    expect(written(error, () => ({ code: 'x' }))).toEqual({ code: '[X]' })
    expect(get).not.toHaveBeenCalled()
  })

  /* What 'safe' drops stays dropped: the detail of a database error. */
  it('does not write the detail of a database error', () => {
    const error = Object.assign(new Error(), { code: '23505', detail: 'Key (a)=(b)' })

    expect(JSON.stringify(written(error, () => ({ detail: 'Key (a)=(b)' })))).not.toContain('(b)')
  })

  /* The walk of the output censors a linked value that holds an own default key. */
  it('censors a cause that has an own default key beside its toJSON', () => {
    const cause = Object.assign(new Error('inner'), {
      password: 'x',
      toJSON: () => ({ message: 'inner' })
    })

    expect(written(new Error('failed', { cause }), () => ({ cause }))).toEqual({ cause: '[X]' })
  })

  /* Both walks count against the bound, and what is past it is not written. */
  it('writes no value past the containers the walk may visit', () => {
    expect(JSON.stringify(written(failed(), () => ({ code: 'E1' }), 2))).not.toContain('E1')
  })
})

/** What is written for a held `Error` under the `err` key, which has a serializer. */
function underErr(cause: Error): unknown {
  const error = new Error('failed', { cause })
  Object.defineProperty(error, 'inner', { value: { pan: 'x' } })
  Object.defineProperty(error, 'toJSON', { value: () => ({ cause }) })
  const hold = createPathHold(['err.pan'], 1000, createOwnFieldPolicy('safe', []))
  const redact = createNameRedactor(
    ['password'],
    '[X]',
    ['err'],
    1000,
    undefined,
    undefined,
    undefined,
    false,
    hold
  )
  return JSON.parse(JSON.stringify(redact({ err: error }, true))) as unknown
}

describe('what is written for a held Error under a serialized key', () => {
  /* An instance keeps its head where the comparison does not read it, so a link is data. */
  it('writes the name, message and stack of a cause', () => {
    const stack = 'Error: refused\n    at run (/srv/app.js:1:1)'
    const cause = Object.assign(new Error('refused'), { stack })

    expect(underErr(cause)).toEqual({
      err: { cause: { name: 'Error', message: 'refused', stack } }
    })
  })

  /* A link is cut as under any other key, so its text is the one `'safe'` writes. */
  it('writes the own enumerable message of a cause as cut', () => {
    const cause = new Error()
    Reflect.deleteProperty(cause, 'message')
    Object.assign(cause, { message: 'm'.repeat(20_000) })
    const { err } = underErr(cause) as { err: { cause: { message: string } } }

    expect(err.cause.message.startsWith('mmm')).toBe(true)
    expect(err.cause.message.length).toBeLessThan(20_000)
  })
})

/** What is written under `err` for a held `Error` with these fields, which its `toJSON` keeps. */
function fieldsUnderErr(fields: Record<string, unknown>, keys: readonly string[]): string {
  const error = Object.assign(new Error('failed'), fields)
  Object.defineProperty(error, 'inner', { value: { pan: 'x' } })
  Object.defineProperty(error, 'toJSON', {
    value: () =>
      Object.fromEntries(keys.map((key) => [key, (error as unknown as typeof fields)[key]]))
  })
  const hold = createPathHold(['err.pan'], 1000, createOwnFieldPolicy('safe', []))
  const redact = createNameRedactor(
    ['password'],
    '[X]',
    ['err'],
    1000,
    undefined,
    undefined,
    undefined,
    false,
    hold
  )
  return JSON.stringify(redact({ err: error }, true))
}

describe('an Error a held Error holds outside its causes and members', () => {
  const inner = (): Error => new Error('INNER')

  /* Only a cause or a member is a link: elsewhere an instance stays one, and writes no head. */
  it.each<readonly [string, string, unknown]>([
    ['a field', 'table', { x: inner() }],
    ['a field that is the Error', 'code', inner()],
    ['a field of a list', 'table', [inner()]],
    ['an object as the cause', 'cause', { name: 'n', message: 'm', extra: inner() }],
    ['a cause of an object as the cause', 'cause', { name: 'n', message: 'm', cause: inner() }],
    ['an object as a member', 'errors', [{ name: 'n', message: 'm', extra: inner() }]]
  ])('does not write the message of one under %s', (_label, key, value) => {
    expect(fieldsUnderErr({ [key]: value }, [key])).not.toContain('INNER')
  })

  /* A member of the output's list is a link, and so is its cause. */
  it('writes the message of a member and of the cause of a member', () => {
    const member = new Error('member', { cause: inner() })
    const written = fieldsUnderErr({ errors: [member] }, ['errors'])

    expect(written).toContain('"message":"member"')
    expect(written).toContain('"message":"INNER"')
  })

  /* An assigned cause is an own enumerable key of the linked Error. */
  it('writes the message of an assigned cause of a member', () => {
    const member = new Error('member')
    member.cause = inner()

    expect(fieldsUnderErr({ errors: [member] }, ['errors'])).toContain('"message":"INNER"')
  })
})

/** What the redactor itself returns for a held `Error` at this depth of the record. */
function walkedAt(depth: number): unknown {
  const error = failed()
  Object.defineProperty(error, 'inner', { value: { pan: 'x' } })
  Object.defineProperty(error, 'toJSON', { value: () => ({ code: 'E1' }) })
  const hold = createPathHold(['u.pan'], 1000, createOwnFieldPolicy('safe', []))
  const redact = createNameRedactor(
    ['password'],
    '[X]',
    undefined,
    1000,
    undefined,
    undefined,
    undefined,
    false,
    hold
  )
  let record: unknown = error
  for (let level = 0; level < depth; level++) record = { u: record }
  let written = redact(record, true)
  for (let level = 0; level < depth; level++) written = (written as { u: unknown }).u
  return written
}

describe('the copy written for a held Error', () => {
  /* A later redaction rewrites and removes what the walk wrote. */
  it('holds ordinary data properties', () => {
    expect(Object.getOwnPropertyDescriptor(walkedAt(1), 'code')).toEqual({
      value: 'E1',
      enumerable: true,
      writable: true,
      configurable: true
    })
  })

  /* What `toJSON` returns is one level below the Error, and counts against the same ceiling. */
  it('writes no value of an output past the depth ceiling', () => {
    expect(walkedAt(REDACT_MAX_TRAVERSAL_DEPTH - 1)).toEqual({ code: 'E1' })
    expect(walkedAt(REDACT_MAX_TRAVERSAL_DEPTH)).toBe('[X]')
  })
})
