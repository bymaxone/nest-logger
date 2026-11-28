/**
 * E2E: under `redactStrategy: 'paths'`, an `Error` whose own state holds a field the paths name is
 * written as what both the walk of its `toJSON` output and the `errorOwnFields: 'safe'` form of it
 * write. Every row runs under each way such an `Error` is logged.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, the Pino factory, the redaction walk).
 */
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const SECRET = 'ZZ-SECRET'

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

/** The lines the module writes under `'paths'` while `emit` runs. */
async function moduleText(
  extra: Partial<BymaxLoggerModuleOptions>,
  emit: (service: PinoLoggerService) => void
): Promise<string> {
  const collector = new Collector()
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-paths-to-json-held', version: '0.0.0' },
        destinations: [collector],
        redactStrategy: 'paths',
        ...extra
      })
    ]
  }).compile()
  await app.init()
  collector.payloads.length = 0
  emit(app.get(PinoLoggerService))
  const text = collector.payloads.join('')
  await app.close()
  return text
}

type Emit = (service: PinoLoggerService, error: Error) => void

/** Each way an `Error` is logged, with the key of the line it is written under. */
const ENTRIES: ReadonlyArray<readonly [string, 'u' | 'err', Emit]> = [
  ['a plain key', 'u', (service, error) => service.getRawLogger().info({ u: error }, 'held')],
  ['the err key', 'err', (service, error) => service.getRawLogger().info({ err: error }, 'held')],
  [
    'raw error({ err })',
    'err',
    (service, error) => service.getRawLogger().error({ err: error }, 'held')
  ],
  ['errorStructured', 'err', (service, error) => service.errorStructured('A_B_FAIL', error, 'u1')]
]

/** The members of a written `Error` the rows read. */
interface Written {
  [key: string]: unknown
  cause?: Written
  errors?: Written[]
}

describe.each(ENTRIES)("a held Error under redactStrategy: 'paths', as %s", (_entry, key, emit) => {
  /** The line `error` writes, and what it writes of the `Error`. */
  const logged = async (
    error: Error,
    extra: Partial<BymaxLoggerModuleOptions> = { redactPaths: [`${key}.pan`] }
  ): Promise<{ text: string; written: Written }> => {
    const text = await moduleText(extra, (service) => {
      expect(() => emit(service, error)).not.toThrow()
    })
    expect(text.trim().split('\n')).toHaveLength(1)
    return { text, written: (JSON.parse(text) as Record<string, Written>)[key] as Written }
  }

  /** An `Error` that is held through `pan`, written as `output` says. */
  const held = <E extends Error>(
    output: (error: E) => unknown,
    error: E = new Error('failed') as E
  ): E => {
    Object.assign(error, { inner: { pan: 'x' } })
    return Object.defineProperty(error, 'toJSON', { value: () => output(error) })
  }

  /* A held `Error` keeps the keys 'safe' writes, and nothing its `toJSON` renames. */
  it.each<readonly [string, (key: string) => Partial<BymaxLoggerModuleOptions>, object]>([
    ['a custom path', (at) => ({ redactPaths: [`${at}.pan`] }), { pan: SECRET }],
    [
      'a host path with the defaults off',
      (at) => ({ redactPaths: [`${at}.password`], shouldDisableDefaultRedact: true }),
      { password: SECRET }
    ],
    ['a nested field of the default set', () => ({}), { inner: { password: SECRET } }],
    [
      'a custom path in its cause',
      (at) => ({ redactPaths: [`${at}.pan`] }),
      { pan: 1, cause: { pan: SECRET } }
    ]
  ])(
    'writes an Error holding %s from the safe keys of its toJSON',
    async (_label, extra, state) => {
      const error = Object.assign(new TypeError('failed'), { code: 'E_KEPT' }, state)
      Object.defineProperty(error, 'toJSON', {
        value: () => ({
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
          credential: SECRET
        })
      })
      const { text, written } = await logged(error, extra(key))

      expect(text).not.toContain(SECRET)
      /* The `err` serializer writes the name as `type`. */
      const name = key === 'err' ? 'type' : 'name'
      expect(written).toMatchObject({ [name]: 'TypeError', message: 'failed', code: 'E_KEPT' })
      expect(written['stack']).toContain('TypeError: failed')
      expect(Object.keys(written)).toEqual([name, 'message', 'stack', 'code'])
    }
  )

  /* The shape an HTTP client throws: the request it made is not written, the failure is. */
  it('writes an HTTP client Error without the request it carries', async () => {
    class ClientError extends Error {
      override name = 'ClientError'
      code = 'ERR_BAD'
      config = { headers: { authorization: SECRET } }
      toJSON(): unknown {
        const { name, message, stack, code, config } = this
        return { name, message, stack, code, config }
      }
    }
    const { text, written } = await logged(new ClientError('status 500'), {})

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('authorization')
    expect(written).toMatchObject({ message: 'status 500', code: 'ERR_BAD' })
    expect(written).not.toHaveProperty('config')
    expect(written['stack']).toContain('status 500')
  })

  /* Never more than the `toJSON` returned, and never a value 'safe' would not write. */
  it.each<readonly [string, (error: Error & { password: string }) => unknown, unknown]>([
    ['a code alone', () => ({ code: 'E_KEPT' }), { code: 'E_KEPT' }],
    ['a field renamed to code', (e) => ({ code: e.password }), { code: '[REDACTED]' }],
    ['a field renamed to message', (e) => ({ message: e.password }), { message: '[REDACTED]' }],
    ['a rewritten message', () => ({ message: 'scrubbed' }), { message: '[REDACTED]' }],
    ['text', (e) => e.password, '[REDACTED]'],
    ['another Error', (e) => new Error(e.password), '[REDACTED]'],
    ['itself', (e) => e, '[REDACTED]'],
    ['a made cause', (e) => ({ cause: new Error(e.password) }), { cause: '[REDACTED]' }],
    [
      'a throw',
      (e) => {
        throw new Error(e.password)
      },
      '[REDACTED]'
    ]
  ])('writes it when its toJSON returns %s', async (_label, output, expected) => {
    const source = Object.assign(new Error('failed'), { password: SECRET })
    const target = Object.assign(new Error('failed'), {
      code: 'E_KEPT',
      inner: { password: SECRET }
    })
    Object.defineProperty(target, 'toJSON', { value: () => output(source) })
    const { text, written } = await logged(target, {})
    /* The `err` serializer shapes what is not error-like. */
    const shaped = {
      type: 'UnknownError',
      message: typeof expected === 'string' ? expected : '[object Object]'
    }

    expect(text).not.toContain(SECRET)
    expect(written).toEqual(key === 'err' ? shaped : expected)
  })

  /* The cause and the members the `Error` has are written, as `'safe'` writes them. */
  it.each<readonly [string, () => Error, (written: Written) => Array<Written | undefined>]>([
    [
      'the cause it was built with',
      () => new Error('failed', { cause: new Error('refused') }),
      (written) => [written.cause]
    ],
    [
      'an assigned cause',
      () => Object.assign(new Error('failed'), { cause: new Error('refused') }),
      (written) => [written.cause]
    ],
    [
      'the cause of its cause',
      () =>
        new Error('failed', {
          cause: new Error('between', { cause: new Error('refused') })
        }),
      (written) => [written.cause?.cause]
    ],
    [
      'its members',
      () => new AggregateError([new Error('refused'), new Error('refused')], 'failed'),
      (written) => written.errors ?? []
    ],
    [
      'the cause of a member',
      () => new AggregateError([new Error('m', { cause: new Error('refused') })], 'failed'),
      (written) => [written.errors?.[0]?.cause]
    ]
  ])('writes %s', async (_label, make, pick) => {
    const error = held(
      (e: Error & { errors?: unknown }) => ({
        name: e.name,
        message: e.message,
        stack: e.stack,
        cause: e.cause,
        errors: e.errors
      }),
      make()
    )
    const { written } = await logged(error)
    const links = pick(written)

    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toMatchObject({ message: 'refused' })
      expect(link?.['name'] ?? link?.['type']).toBe('Error')
      expect(link?.['stack']).toContain('Error: refused')
    }
  })

  /* A linked value with a `toJSON` of its own keeps the cause its result holds. */
  describe.each<readonly [string, Partial<BymaxLoggerModuleOptions>]>([
    ['the paths alone', {}],
    ["errorOwnFields: 'safe'", { errorOwnFields: 'safe' }]
  ])('with %s', (_config, extra) => {
    /** The head of a linked value over `cause`, as its `toJSON` returns it. */
    const parts = (cause: unknown): object => ({ name: 'Error', message: 'between', cause })
    /** An `Error` with a `toJSON` of its own, over `cause`. */
    const between = (output: (cause: unknown) => unknown): Error => {
      const error = new Error('between', { cause: new Error('refused') })
      return Object.defineProperty(error, 'toJSON', { value: () => output(error.cause) })
    }

    it.each<readonly [string, () => unknown]>([
      ['an Error', () => between(parts)],
      ['an Error through two toJSON', () => between((cause) => ({ toJSON: () => parts(cause) }))],
      ['an object', () => ({ toJSON: () => parts(new Error('refused')) })]
    ])('writes the cause below %s as the cause and as a member', async (_label, make) => {
      for (const link of ['cause', 'errors'] as const) {
        const error = Object.assign(new Error('failed'), {
          [link]: link === 'cause' ? make() : [make()]
        })
        const { written } = await logged(
          held((e: Error & { errors?: unknown }) => {
            return { name: e.name, message: e.message, cause: e.cause, errors: e.errors }
          }, error),
          { redactPaths: [`${key}.pan`], ...extra }
        )
        const below = link === 'cause' ? written.cause?.cause : written.errors?.[0]?.cause

        expect(below).toMatchObject({ message: 'refused' })
      }
    })
  })

  /* An object that is no `Error` does not end the chain: what is below it is still linked. */
  it.each<readonly [string, () => unknown, (link: Written) => Written | undefined]>([
    [
      'the cause',
      () => ({ name: 'N', message: 'between', cause: new Error('refused') }),
      (link) => link.cause
    ],
    [
      'a member',
      () => ({ name: 'N', message: 'between', errors: [new Error('refused')] }),
      (link) => link.errors?.[0]
    ],
    [
      'the cause of the cause',
      () => ({
        name: 'N',
        message: 'between',
        cause: { name: 'M', message: 'lower', cause: new Error('refused') }
      }),
      (link) => link.cause?.cause
    ]
  ])('writes an Error that is %s of a plain object', async (_label, make, pick) => {
    for (const link of ['cause', 'errors'] as const) {
      const error = Object.assign(new Error('failed'), {
        [link]: link === 'cause' ? make() : [make()]
      })
      const { written } = await logged(
        held((e: Error & { errors?: unknown }) => {
          return { name: e.name, message: e.message, cause: e.cause, errors: e.errors }
        }, error)
      )
      const between = (link === 'cause' ? written.cause : written.errors?.[0]) as Written
      const below = pick(between)

      expect(below).toMatchObject({ message: 'refused' })
      expect(below?.['name'] ?? below?.['type']).toBe('Error')
    }
  })

  /* A nested `Error` whose `toJSON` returns no name: under a serialized key it keeps the name
     'safe' writes, and its message where `toJSON` returned it unchanged. */
  it.each<readonly [string, (error: Error) => unknown, string]>([
    ['its message', (e) => ({ message: e.message }), 'refused'],
    ['a rewritten message', () => ({ message: 'scrubbed' }), '[REDACTED]'],
    [
      'its message through a second toJSON',
      (e) => ({ toJSON: () => ({ message: e.message }) }),
      'refused'
    ]
  ])(
    'writes a nested Error whose toJSON returns %s and no name',
    async (_label, output, message) => {
      const inner = new TypeError('refused')
      Object.defineProperty(inner, 'toJSON', { value: () => output(inner) })
      for (const between of [
        new Error('between', { cause: inner }),
        new AggregateError([inner], 'between'),
        new Error('between', { cause: new Error('lower', { cause: inner }) })
      ]) {
        const error = Object.assign(new Error('failed'), { cause: between })
        const { written } = await logged(
          held((e) => ({ name: e.name, message: e.message, cause: e.cause }), error)
        )
        const first = (written.cause?.cause ?? written.cause?.errors?.[0]) as Written
        const below = first.cause ?? first

        expect(below).toEqual(key === 'err' ? { name: 'TypeError', message } : { message })
      }
    }
  )

  /* Where the nested toJSON ran before this walk too, nothing is added to what it returned. */
  it.each<readonly [string, (inner: Error) => unknown]>([
    ['a plain object', (inner) => ({ name: 'N', message: 'between', cause: inner })],
    ['an assigned field', (inner) => Object.assign(new Error('between'), { cause: inner })]
  ])('writes no name for a nameless toJSON below %s', async (_label, between) => {
    const inner = new TypeError('refused', { cause: { name: 'P', message: 'p', extra: 'MORE' } })
    Object.defineProperty(inner, 'toJSON', {
      value: () => ({ message: inner.message, cause: inner.cause })
    })
    const error = Object.assign(new Error('failed'), { cause: between(inner) })
    const { text } = await logged(
      held((e) => ({ name: e.name, message: e.message, cause: e.cause }), error)
    )

    expect(text.includes('MORE')).toBe(key !== 'err')
  })

  /* A direct cause is not nested: it is written from what `toJSON` returned alone. */
  it('writes no name for a direct cause whose toJSON returns none', async () => {
    const inner = new TypeError('refused')
    Object.defineProperty(inner, 'toJSON', { value: () => ({ message: inner.message }) })
    const error = Object.assign(new Error('failed'), { cause: inner })
    const { written } = await logged(
      held((e) => ({ name: e.name, message: e.message, cause: e.cause }), error)
    )

    expect(written.cause).toEqual(
      key === 'err' ? { name: 'UnknownError', message: '[object Object]' } : { message: 'refused' }
    )
  })

  /* Outside a serialized key nothing reads the name, so an own one `toJSON` left out stays out. */
  it('keeps out a name of its own that the toJSON of a nested Error left out', async () => {
    const inner = Object.assign(new Error('refused'), { name: 'OwnError' })
    Object.defineProperty(inner, 'toJSON', { value: () => ({ message: inner.message }) })
    const error = Object.assign(new Error('failed'), {
      cause: new Error('between', { cause: inner })
    })
    const { written } = await logged(
      held((e) => ({ name: e.name, message: e.message, cause: e.cause }), error)
    )

    expect(written.cause?.cause).toEqual(
      key === 'err' ? { name: 'OwnError', message: 'refused' } : { message: 'refused' }
    )
  })

  /* The name is added only where `toJSON` left a message: one that returned none stays as it was. */
  it('does not write the message of a nested Error whose toJSON returns none', async () => {
    const inner = new TypeError(SECRET)
    Object.defineProperty(inner, 'toJSON', { value: () => ({ code: 'E_KEPT' }) })
    const error = Object.assign(new Error('failed'), {
      cause: new Error('between', { cause: inner })
    })
    const { text } = await logged(
      held((e) => ({ name: e.name, message: e.message, cause: e.cause }), error)
    )

    expect(text).not.toContain(SECRET)
  })

  /* A linked `Error` loses what `'safe'` drops and what the default names censor. */
  it.each<readonly [string, object]>([
    ['a field of its own', { detail: SECRET }],
    ['a redacted field below it', { context: { password: SECRET } }]
  ])('does not write %s of a cause', async (_label, state) => {
    const cause = Object.assign(new Error('refused'), state)
    const error = held(
      (e) => ({ name: e.name, message: e.message, cause: e.cause }),
      new Error('failed', { cause })
    )
    const { text, written } = await logged(error)

    expect(text).not.toContain(SECRET)
    expect(written.cause).toMatchObject({ message: 'refused' })
  })

  /* A member the `Error` does not have is not written, however many the output makes up. */
  it('writes the censor for members its toJSON makes', async () => {
    const error = held(() => ({ errors: [new Error(SECRET), new Error(SECRET)] }), {
      ...new AggregateError([], 'failed'),
      name: 'AggregateError',
      message: 'failed'
    } as Error)
    const { text } = await logged(error)

    expect(text).not.toContain(SECRET)
  })

  /* A linked value with a `toJSON` and an own default key is the censor, whole. */
  it('censors a cause whose toJSON sits beside an own default key', async () => {
    const cause = Object.assign(new Error(SECRET), {
      password: 'x',
      toJSON: () => ({ message: SECRET })
    })
    const error = held(
      () => ({ name: 'Error', message: 'failed', cause }),
      Object.assign(new Error('failed'), { cause })
    )
    const { text, written } = await logged(error)

    expect(text).not.toContain(SECRET)
    /* The `err` serializer shapes the censor where it expects an `Error`. */
    const shaped = { name: 'UnknownError', message: '[REDACTED]' }
    expect(written.cause).toEqual(key === 'err' ? shaped : '[REDACTED]')
  })

  /* A masking view the output puts on itself decides what is written. */
  it("does not write past the output's own toJSON", async () => {
    const view = { message: SECRET, toJSON: () => 'masked' }
    const error = held(() => view, new Error(SECRET))

    /* `errorStructured` writes the message as `msg`, so only the `Error` written is read. */
    expect(JSON.stringify((await logged(error)).written)).not.toContain(SECRET)
  })

  /* The same view on the list of members. */
  it('does not write past the toJSON of the list of members', async () => {
    const members = [new Error(SECRET)]
    const view = Object.assign([...members], { toJSON: () => 'masked' })
    const error = held(
      () => ({ errors: view }),
      Object.assign(new Error('failed'), { errors: members })
    )

    expect((await logged(error)).text).not.toContain(SECRET)
  })

  /* What `JSON.stringify` does not see on the output is not written. */
  it('does not write a non-enumerable cause of the output', async () => {
    const cause = new Error(SECRET)
    const error = held(
      () => Object.defineProperty({ message: 'failed' }, 'cause', { value: cause }),
      Object.assign(new Error('failed'), { cause })
    )

    expect((await logged(error)).text).not.toContain(SECRET)
  })

  /* What `'safe'` reads is read before `toJSON` can change it. */
  it('does not write what toJSON puts on the Error before returning it', async () => {
    const error = held((e) => {
      e.message = SECRET
      return { message: SECRET }
    })

    expect((await logged(error)).text).not.toContain(SECRET)
  })

  /* A renamed redacted value under an allow-listed or head key is the censor. */
  it.each(['code', 'message'])('writes the censor for a password renamed to %s', async (name) => {
    const error = Object.assign(new Error('failed'), {
      password: SECRET,
      toJSON: () => ({ [name]: SECRET })
    })
    const { text } = await logged(error, { redactPaths: [`${key}.password`] })

    expect(text).not.toContain(SECRET)
    expect(text).toContain('[REDACTED]')
  })

  /* `message` and `stack` are what 'safe' writes: the paths and the cut apply to them. */
  it.each<readonly [string, Partial<BymaxLoggerModuleOptions>]>([
    ['a path to its message', { redactPaths: [`${key}.message`] }],
    ['a path to its stack', { redactPaths: [`${key}.stack`] }],
    ['maxStringLength', { maxStringLength: 64 }]
  ])("writes message and stack under %s as under 'safe'", async (_label, extra) => {
    class Held extends Error {
      toJSON(): unknown {
        return { name: this.name, message: this.message, stack: this.stack }
      }
    }
    const lines = async (more: Partial<BymaxLoggerModuleOptions>): Promise<unknown> => {
      const error = Object.assign(new Held(`${SECRET} ${'long '.repeat(20)}`), {
        inner: { password: 1 }
      })
      error.stack = `Held: ${error.message}\n    at frame`
      const { written } = await logged(error, { ...extra, ...more })
      return { message: written['message'], stack: written['stack'] }
    }

    expect(await lines({})).toEqual(await lines({ errorOwnFields: 'safe' }))
  })

  /* A getter among the fields of a held `Error` is not run; its `toJSON` is. */
  it('runs no getter of a held Error', async () => {
    let runs = 0
    const error = new Error('failed')
    Object.defineProperty(error, 'inner', {
      get: () => {
        runs++
        return 'x'
      },
      enumerable: true
    })
    Object.defineProperty(error, 'toJSON', { value: () => ({ name: 'Error', message: 'failed' }) })
    const { written } = await logged(error)

    expect(runs).toBe(0)
    expect(written['message']).toBe('failed')
  })

  /* A `message` or `stack` accessor that throws does not throw out of the log call. */
  it('logs it when its message and stack cannot be read', async () => {
    const error = Object.assign(new Error(), { inner: { password: SECRET } })
    const fail = (): never => {
      throw new Error('unreadable')
    }
    Object.defineProperty(error, 'message', { get: fail })
    Object.defineProperty(error, 'stack', { get: fail })
    Object.defineProperty(error, 'toJSON', { value: () => ({ message: SECRET }) })

    expect((await logged(error, {})).text).not.toContain(SECRET)
  })

  /* Causes that point at each other end the copy. */
  it('writes it when its causes form a cycle', async () => {
    const first = Object.assign(new Error('first'), { inner: { password: SECRET } })
    const second = new Error('second', { cause: first })
    Object.defineProperty(first, 'cause', { value: second })
    Object.defineProperty(first, 'toJSON', {
      value: () => ({ name: 'Error', message: 'first', cause: second })
    })
    const { text } = await logged(first, {})

    expect(text).not.toContain(SECRET)
    expect(text).toContain('second')
    expect(text.length).toBeLessThan(10_000)
  }, 5000)
})
