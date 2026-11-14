/**
 * Verifies createNameRedactor on values with their own serialization: Errors, toJSON, binary views,
 * class instances, frozen and non-configurable properties and a __proto__ key, plus a marked
 * envelope when traversal throws, a custom censor, case-insensitive names and an empty name set.
 *
 * Layer: server/utils, tests.
 */
import { REDACT_DEPTH_EXCEEDED, createNameRedactor } from './redact-by-name.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

const CENSOR = '[REDACTED]'
const redact = createNameRedactor(
  ['password', 'authorization', 'set-cookie', 'x-api-key', 'accessToken'],
  CENSOR
)

describe('createNameRedactor', () => {
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
   * REGRESSION — the `Buffer` fast path hands back the ORIGINAL reference, and
   * `JSON.stringify` reads `toJSON` again from it. When the property is an
   * ACCESSOR, the second read can answer differently: a getter returning
   * `Buffer.prototype.toJSON` to the walk took the fast path, and the stringifier
   * then got a factory synthesizing `{ password }` — in clear, past both hooks.
   * Identity proves nothing about the next read unless it is a data property.
   */
  'should refuse the binary fast path when toJSON is an accessor', () => {
    let reads = 0
    const trap = {}
    Object.defineProperty(trap, 'toJSON', {
      get(): unknown {
        reads++
        return reads === 1 ? Buffer.prototype.toJSON : (): unknown => ({ password: 'SECRET' })
      },
      enumerable: false,
      configurable: true
    })

    const serialized = JSON.stringify(redact({ payload: trap }))

    expect(serialized).not.toContain('SECRET')
    // The walk reads the property exactly ONCE — its whole premise is observing
    // caller state a single time, and it used to read this twice.
    expect(reads).toBe(1)
  })

  it(/*
   * The converse: an accessor is not punished for being one. A getter returning
   * an ordinary method still has its OUTPUT walked and pinned, so a legitimate
   * value is neither dropped nor censored — and a getter that answers differently
   * on a later read cannot change what was emitted, because the snapshot is what
   * ships.
   */
  'should pin the output of an accessor toJSON that shifts between reads', () => {
    let reads = 0
    const shifty = {}
    Object.defineProperty(shifty, 'toJSON', {
      get(): unknown {
        reads++
        return (): unknown => (reads === 1 ? { units: 7 } : { password: 'SECRET' })
      },
      enumerable: false,
      configurable: true
    })

    const serialized = JSON.stringify(redact({ measure: shifty }))

    expect(serialized).toBe('{"measure":{"units":7}}')
    expect(serialized).not.toContain('SECRET')
  })

  it(/*
   * REGRESSION — following `toJSON` output did not advance the depth counter, so
   * a chain where each `toJSON()` returns a FRESH object carrying another one
   * recursed forever: nothing repeats, so the ancestor set never matches, and the
   * ceiling was never reached. The stack exhausted instead. Contained by the root
   * catch, but it cost the WHOLE record — where the ceiling costs one value.
   */
  'should stop a toJSON chain at the traversal ceiling, keeping the record', () => {
    const infinite: { toJSON: () => unknown } = {
      toJSON: (): unknown => ({ toJSON: infinite.toJSON })
    }

    const serialized = JSON.stringify(redact({ chain: infinite, sibling: 'kept' }))

    expect(serialized).toContain(REDACT_DEPTH_EXCEEDED)
    // The rest of the record survives — this is the difference between the
    // ceiling firing and the stack blowing up.
    expect(serialized).toContain('"sibling":"kept"')
    expect(serialized).not.toContain('_redactionFailed')
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
  'should serialize toJSON-bearing values and write a binary view as its size', () => {
    const when = new Date('2020-01-01T00:00:00.000Z')
    const buf = Buffer.from('hi')
    const result = redact({ when, buf }) as Record<string, unknown>
    // The `toJSON` result is substituted rather than the object passed through:
    // returning the original would let `JSON.stringify` call the method again.
    // The emitted JSON is identical either way.
    expect(result['when']).toBe('2020-01-01T00:00:00.000Z')
    expect(JSON.stringify(result['when'])).toBe(JSON.stringify(when))
    // A `Buffer` is nobody's log data: it is written as its size, not as its bytes.
    expect(result['buf']).toBe('[Binary 2 bytes]')
  })

  it(/*
   * A binary view a caller has extended can carry a secret in an own `toJSON` or in an own
   * property, and `JSON.stringify` would write it. Every view is written as its size, whatever it
   * carries, so none of those shapes can reach the sink.
   */
  'should write a binary view a caller has extended as its size, whatever it carries', () => {
    const withOwnToJson = Object.assign(Buffer.from('hi'), {
      toJSON: (): unknown => ({ password: 'SECRET' })
    })
    const typedArray = Object.assign(new Uint8Array([1, 2]), { password: 'SECRET' })
    const dataView = Object.assign(new DataView(new ArrayBuffer(2)), { password: 'SECRET' })

    expect(JSON.stringify(redact({ b: withOwnToJson }))).toBe('{"b":"[Binary 2 bytes]"}')
    expect(JSON.stringify(redact({ u: typedArray }))).toBe('{"u":"[Binary 2 bytes]"}')
    expect(JSON.stringify(redact({ d: dataView }))).toBe('{"d":"[Binary 2 bytes]"}')
  })

  it(/*
   * A SUBCLASS of a view can define `toJSON` on its own prototype, which is neither own nor
   * canonical. It is a view like any other and is written as its size, so what its `toJSON`
   * returns never reaches the sink.
   */
  'should write a view subclass that overrides toJSON as its size', () => {
    class SecretView extends Uint8Array {
      toJSON(): unknown {
        return { password: 'SECRET' }
      }
    }

    expect(JSON.stringify(redact({ v: new SecretView([1, 2]) }))).toBe('{"v":"[Binary 2 bytes]"}')
  })

  it(/*
   * A real `Buffer` is not recursed over byte by byte, and it is not handed on: the marker is a
   * string that holds no reference to it.
   */
  'should write a Buffer as its size and not by reference', () => {
    const buf = Buffer.from('hi')
    expect((redact({ buf }) as Record<string, unknown>)['buf']).toBe('[Binary 2 bytes]')
  })

  it(/*
   * An ordinary binary payload renders as its size, never as its bytes, which is what keeps a
   * failed child process's output out of a line.
   */
  'should render pristine binary views as their size and not as their bytes', () => {
    const pristine = { b: Buffer.from('hi'), u: new Uint8Array([1, 2]) }
    expect(JSON.stringify(redact(pristine))).toBe('{"b":"[Binary 2 bytes]","u":"[Binary 2 bytes]"}')
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
   * REGRESSION — an `Error` carrying a NON-CONFIGURABLE enumerable secret once
   * leaked it: `Reflect.defineProperty` reports failure by returning `false`
   * rather than throwing, so writing the censor silently no-opped and the raw
   * value survived into the log. The guard that closed the leak dropped the whole
   * record instead, which traded a leak for total loss.
   *
   * Neither is necessary. The clone is transient — built, serialized, discarded —
   * so it is now built with relaxed descriptors and the censor always lands. The
   * security assertion below is UNCHANGED and still the point: `SECRET` must not
   * appear. What changed is that the surrounding fields survive with it.
   *
   * Reverting the descriptor relaxation in `cloneError` makes this fail.
   */
  'should censor a non-configurable secret instead of leaking or dropping it', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'password', {
      value: 'SECRET',
      enumerable: true,
      writable: false,
      configurable: false
    })

    const result = redact({ err }) as Record<string, unknown>

    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect((result['err'] as Record<string, unknown>)['password']).toBe(CENSOR)
    expect(result['_redactionFailed']).toBeUndefined()
  })

  it(/*
   * REGRESSION — a FROZEN error lost every field, including its own message.
   * A consumer that freezes its errors so nobody mutates an issue list after the
   * throw hands over properties that are neither writable nor configurable. The
   * clone inherited those descriptors, and rewriting a key whose walked value is
   * a fresh object — any nested array or object, censored or not — could not
   * redefine it. That failure reached the caller's guard and dropped the record,
   * so the one entry worth logging became `_redactionFailed: true` and nothing
   * else. Total silent loss on the error that crashed the process.
   *
   * A frozen error with a SCALAR property never showed it: redefining with the
   * same primitive succeeds, so only a nested object exposes the defect.
   *
   * Reverting the descriptor relaxation in `cloneError` makes this fail.
   */
  'should keep the stack of a frozen error', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'code', {
      value: 'E_CFG',
      enumerable: true,
      writable: false,
      configurable: false
    })
    Object.freeze(err)

    const result = redact({ err }) as Record<string, unknown>
    const cloned = result['err'] as Error

    // V8 exposes `stack` as an own property bound to the original's internal state,
    // so the clone gets a resolved copy pinned onto it. On a FROZEN error that pin
    // used to fail silently — `Reflect.defineProperty` returns `false` rather than
    // throwing — and the entry reached the sink with its trace erased, in the case
    // that did NOT drop the record and therefore looked healthy.
    expect(cloned).toBeInstanceOf(Error)
    expect(cloned.stack).toContain('boom')
  })

  it(/*
   * REGRESSION — a FROZEN error lost every field, including its own message.
   * A consumer that freezes its errors so nobody mutates an issue list after the
   * throw hands over properties that are neither writable nor configurable. The
   * clone inherited those descriptors, and rewriting a key whose walked value is
   * a fresh object — any nested array or object, censored or not — could not
   * redefine it. That failure reached the caller's guard and dropped the record,
   * so the one entry worth logging became `_redactionFailed: true` and nothing
   * else. Total silent loss on the error that crashed the process.
   *
   * A frozen error with a SCALAR property never showed it: redefining with the
   * same primitive succeeds, so only a nested object exposes the defect.
   *
   * Reverting the descriptor relaxation in `cloneError` makes this fail.
   */
  'should keep a frozen error whose property is an object', () => {
    const err = new Error('config invalid')
    Object.defineProperty(err, 'issues', {
      value: Object.freeze([{ path: 'database.url' }]),
      enumerable: true,
      writable: false,
      configurable: false
    })
    Object.freeze(err)

    const result = redact({ err }) as Record<string, unknown>

    expect(result['_redactionFailed']).toBeUndefined()
    // Still an Error, still carrying its own message — `message` is non-enumerable,
    // so it is the `err` serializer that lifts it into the entry, not this layer.
    expect(result['err']).toBeInstanceOf(Error)
    expect((result['err'] as Error).message).toBe('config invalid')
    expect(JSON.stringify(result)).toContain('database.url')
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
