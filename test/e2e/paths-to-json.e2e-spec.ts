/**
 * E2E: under `redactStrategy: 'paths'`, a value with a `toJSON` whose own state holds a field the
 * paths name is written as the censor, whole. An `Error` is written from what its `toJSON`
 * returns, cut to what `errorOwnFields: 'safe'` would write for it.
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

/** A `toJSON` that writes a redacted field under another name. */
class Renaming {
  password = SECRET
  toJSON(): unknown {
    return { credential: this.password }
  }
}

/** The same, with the method as an own property of the value. */
const renamingLiteral = (): unknown => ({
  password: SECRET,
  toJSON(this: { password: string }) {
    return { credential: this.password }
  }
})

/** An `Error` whose own `toJSON` renames a redacted field. */
class RenamingError extends Error {
  password = SECRET
  toJSON(): unknown {
    return { credential: this.password }
  }
}

const VALUES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['a class instance', () => new Renaming()],
  ['an object literal', renamingLiteral],
  ['an Error', () => new RenamingError('failed')]
]

const PLACES: ReadonlyArray<readonly [string, (value: unknown) => Record<string, unknown>]> = [
  ['a field of the record', (value) => ({ u: value })],
  ['a nested field', (value) => ({ a: { u: value } })],
  ['a member of an array', (value) => ({ list: [value] })]
]

const CONFIGS: ReadonlyArray<readonly [string, Partial<BymaxLoggerModuleOptions>]> = [
  ['the default paths', {}],
  ["errorOwnFields: 'safe'", { errorOwnFields: 'safe' }],
  ['maxStringLength', { maxStringLength: 1000 }]
]

/** The lines the module writes under `'paths'` while `emit` runs. */
async function moduleText(
  extra: Partial<BymaxLoggerModuleOptions>,
  emit: (service: PinoLoggerService) => void
): Promise<string> {
  const collector = new Collector()
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-paths-to-json', version: '0.0.0' },
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

describe("a toJSON under redactStrategy: 'paths'", () => {
  describe.each(CONFIGS)('with %s', (_label, extra) => {
    describe.each(PLACES)('as %s', (_place, wrap) => {
      /* The field the paths name is censored whatever the `toJSON` renames it to. */
      it.each(VALUES)('does not write the redacted field of %s', async (_value, make) => {
        const text = await moduleText(extra, (service) => {
          service.getRawLogger().info(wrap(make()), 'm')
        })

        expect(text).not.toContain(SECRET)
        /* Under 'safe' an `Error` is written from its allow-listed fields: nothing to censor. An
         * `Error` with an own sensitive key is censored whole under the default names. */
        if (!(_value === 'an Error' && extra.errorOwnFields === 'safe')) {
          expect(text).toContain('[REDACTED]')
        }
      })
    })

    /* The service meta is a field of the record too. */
    it('does not write the redacted field of structured meta', async () => {
      const text = await moduleText(extra, (service) => {
        service.info('A_B_OK', 'm', 'u1', { u: new Renaming() })
      })

      expect(text).not.toContain(SECRET)
      expect(text).toContain('[REDACTED]')
    })
  })

  /* A value the paths name nothing of keeps what its `toJSON` returns. */
  it('writes a value whose state holds no named field as its toJSON returns it', async () => {
    const value = { owner: { id: 7 }, toJSON: () => ({ ref: 'kept' }) }
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: value, at: new Date(0) }, 'm')
    })

    expect(text).toContain('"u":{"ref":"kept"}')
    expect(text).toContain('"at":"1970-01-01T00:00:00.000Z"')
  })

  /* The name is the last segment of a path, wherever the state holds it. */
  it.each<readonly [string, () => unknown]>([
    ['nested state', () => ({ inner: { password: SECRET } })],
    ['a member of a list', () => ({ list: [{ password: SECRET }] })],
    ['a non-enumerable field', () => Object.defineProperty({}, 'password', { value: SECRET })],
    ['a Buffer beside it', () => ({ password: SECRET, raw: Buffer.from('ab') })],
    ['an Error beside it', () => ({ password: SECRET, cause: new Error('failed') })],
    ['a cycle', () => Object.assign({ password: SECRET } as Record<string, unknown>, { self: {} })],
    [
      'a getter, which is not run',
      () => ({
        get inner(): unknown {
          throw new Error('run')
        }
      })
    ]
  ])('writes the censor for a value holding %s', async (_label, state) => {
    const value = state() as Record<string, unknown>
    if ('self' in value) value['self'] = value
    Object.defineProperty(value, 'toJSON', {
      value: () => ({ credential: SECRET })
    })
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: value }, 'm')
    })

    expect(text).toContain('"u":"[REDACTED]"')
    expect(text).not.toContain(SECRET)
  })

  /* A host path adds its last segment, and a path ending in `*` names every field. */
  it.each<readonly [string, string, boolean]>([
    ['u.pan', '4111', true],
    ['u.*', '4111', true],
    ['u["pan"]', '4111', true],
    ['u.other', '4111', false]
  ])('decides by the host path %s', async (path, pan, censored) => {
    class Card {
      pan = pan
      toJSON(): unknown {
        return { number: this.pan }
      }
    }
    for (const shouldDisableDefaultRedact of [false, true]) {
      const text = await moduleText(
        { shouldDisableDefaultRedact, redactPaths: [path] },
        (service) => {
          service.getRawLogger().info({ u: new Card(), at: new Date(0) }, 'm')
          service.getRawLogger().info({ e: Object.assign(new RenamingError('failed'), { pan }) })
        }
      )

      expect(text.includes(pan)).toBe(!censored)
      /* A `Date` has no field of its own, so no path censors it. */
      expect(text).toContain('"at":"1970-01-01T00:00:00.000Z"')
    }
  })

  /* A held `Error` keeps the keys 'safe' writes, and nothing its `toJSON` renames. */
  it.each<readonly [string, Partial<BymaxLoggerModuleOptions>, object]>([
    ['a custom path', { redactPaths: ['u.pan'] }, { pan: SECRET }],
    [
      'a host path with the defaults off',
      { redactPaths: ['u.password'], shouldDisableDefaultRedact: true },
      { password: SECRET }
    ],
    ['a nested field of the default set', {}, { inner: { password: SECRET } }],
    ['a custom path in its cause', { redactPaths: ['u.pan'] }, { pan: 1, cause: { pan: SECRET } }]
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
      const text = await moduleText(extra, (service) => {
        service.getRawLogger().info({ u: error }, 'm')
      })
      const written = (JSON.parse(text) as { u: Record<string, unknown> }).u

      expect(text).not.toContain(SECRET)
      expect(written).toMatchObject({ name: 'TypeError', message: 'failed', code: 'E_KEPT' })
      expect(written['stack']).toContain('TypeError: failed')
      expect(Object.keys(written)).toEqual(['name', 'message', 'stack', 'code'])
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
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ err: new ClientError('status 500') }, 'm')
      service.errorStructured('A_B_FAIL', new ClientError('status 500'), 'u1')
    })

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('authorization')
    for (const line of text.trim().split('\n')) {
      const { err } = JSON.parse(line) as { err: Record<string, unknown> }
      expect(err).toMatchObject({ message: 'status 500', code: 'ERR_BAD' })
      expect(err).not.toHaveProperty('config')
      expect(err['stack']).toContain('status 500')
    }
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
  ])('writes a held Error whose toJSON returns %s', async (_label, output, expected) => {
    const error = Object.assign(new Error('failed'), { password: SECRET, code: 'E_KEPT' })
    const target = Object.assign(new Error('failed'), {
      code: 'E_KEPT',
      inner: { password: SECRET }
    })
    Object.defineProperty(target, 'toJSON', { value: () => output(error) })
    const text = await moduleText({}, (service) => {
      expect(() => service.getRawLogger().info({ u: target }, 'm')).not.toThrow()
    })

    expect(text).not.toContain(SECRET)
    expect((JSON.parse(text) as { u: unknown }).u).toEqual(expected)
  })

  /* `message` and `stack` are what 'safe' writes: the paths and the cut apply to them. */
  it.each<readonly [string, Partial<BymaxLoggerModuleOptions>]>([
    ['a path to err.message', { redactPaths: ['err.message'] }],
    ['a path to u.message', { redactPaths: ['u.message'] }],
    ['a path to u.stack', { redactPaths: ['u.stack'] }],
    ['maxStringLength', { maxStringLength: 64 }]
  ])("writes message and stack under %s as under 'safe'", async (_label, extra) => {
    class Held extends Error {
      toJSON(): unknown {
        return { name: this.name, message: this.message, stack: this.stack }
      }
    }
    const make = (): Error =>
      Object.assign(new Held(`${SECRET} ${'long '.repeat(20)}`), { inner: { password: 1 } })
    const lines = async (more: Partial<BymaxLoggerModuleOptions>): Promise<unknown[]> => {
      const error = make()
      error.stack = `Held: ${error.message}\n    at frame`
      const text = await moduleText({ ...extra, ...more }, (service) => {
        service.getRawLogger().info({ err: error }, 'm')
        service.getRawLogger().info({ u: error }, 'm')
      })
      return text
        .trim()
        .split('\n')
        .map((line) => {
          const { err, u } = JSON.parse(line) as Record<string, Record<string, unknown>>
          const node = (err ?? u) as Record<string, unknown>
          return { message: node['message'], stack: node['stack'] }
        })
    }

    expect(await lines({})).toEqual(await lines({ errorOwnFields: 'safe' }))
  })

  /* A getter on the held `Error` is not run; its `toJSON` is, as for any other value. */
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
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: error }, 'm')
      service.getRawLogger().info({ err: error }, 'm')
    })

    expect(runs).toBe(0)
    expect(text.match(/"message":"failed"/g)?.length).toBe(2)
  })

  /* A `message` or `stack` accessor that throws does not throw out of the log call. */
  it('logs a held Error whose message and stack cannot be read', async () => {
    const error = Object.assign(new Error(), { inner: { password: SECRET } })
    const fail = (): never => {
      throw new Error('unreadable')
    }
    Object.defineProperty(error, 'message', { get: fail })
    Object.defineProperty(error, 'stack', { get: fail })
    Object.defineProperty(error, 'toJSON', { value: () => ({ message: SECRET }) })
    const text = await moduleText({}, (service) => {
      expect(() => service.getRawLogger().info({ u: error }, 'one')).not.toThrow()
      expect(() => service.getRawLogger().info({ err: error }, 'two')).not.toThrow()
      expect(() => service.errorStructured('A_B_FAIL', error, 'u1')).not.toThrow()
    })

    expect(text).not.toContain(SECRET)
    expect(text.trim().split('\n')).toHaveLength(3)
  })

  /* Causes that point at each other end the copy. */
  it('writes a held Error whose causes form a cycle', async () => {
    const first = Object.assign(new Error('first'), { inner: { password: SECRET } })
    const second = new Error('second', { cause: first })
    Object.defineProperty(first, 'cause', { value: second })
    Object.defineProperty(first, 'toJSON', { value: () => ({ cause: second }) })
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: first }, 'm')
      service.getRawLogger().info({ err: first }, 'm')
    })

    expect(text).not.toContain(SECRET)
    expect(text.trim().split('\n')).toHaveLength(2)
    expect(text).toContain('second')
    expect(text.length).toBeLessThan(10_000)
  }, 5000)

  /* The searches of one call share a bound: past it a value is the censor, held or not. */
  it('censors a value past the work one log call may do', async () => {
    const wide = { list: new Array<number>(300_000).fill(0), toJSON: () => 'kept' }
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: wide }, 'm')
    })

    expect(text).toContain('"u":"[REDACTED]"')
  })

  /* A path naming `message` or `stack` names the built ones, so a rename of one is not written. */
  it.each(['message', 'stack'])('censors a value renaming the %s a path names', async (key) => {
    const inner = new Error(SECRET)
    inner.stack = SECRET
    const value = { inner, toJSON: () => ({ renamed: SECRET }) }
    const text = await moduleText({ redactPaths: [`u.${key}`] }, (service) => {
      service.getRawLogger().info({ u: value }, 'm')
    })

    expect(text).toContain('"u":"[REDACTED]"')
    expect(text).not.toContain(SECRET)
  })

  /* A function-valued field is part of the state. */
  it('censors a value holding the named field on a function', async () => {
    const client = Object.assign(() => 'x', { password: SECRET })
    const value = { client, toJSON: () => ({ renamed: SECRET }) }
    const text = await moduleText({}, (service) => {
      service.getRawLogger().info({ u: value }, 'm')
    })

    expect(text).toContain('"u":"[REDACTED]"')
    expect(text).not.toContain(SECRET)
  })

  /* The child bindings and a value formatted into the message follow the same rule. */
  it('censors the value in child bindings and in a message', async () => {
    const text = await moduleText({}, (service) => {
      service.getRawLogger().child({ u: new Renaming() }).info('c')
      service.getRawLogger().info('%j', new Renaming())
      service.getRawLogger().info('%o', { u: new Renaming() })
    })

    expect(text).not.toContain(SECRET)
    expect(text.match(/\[REDACTED\]/g)?.length).toBe(3)
  })
})
