import pino from 'pino'
import type { Logger } from 'pino'

import type { SanitizedError } from '../utils/sanitize-error.util'

import { PinoLoggerService } from './pino-logger.service'

describe('PinoLoggerService', () => {
  let rawLogger: Logger
  let service: PinoLoggerService

  beforeEach(() => {
    // A real but silent Pino instance lets us spy on the level methods without
    // fabricating a Logger mock (which would need an unsafe cast).
    rawLogger = pino({ enabled: false })
    service = new PinoLoggerService(rawLogger)
  })

  describe('structured API', () => {
    it(/*
     * info() must emit the logKey, userId, context, and merged metadata.
     */
    'emits a structured info entry', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.setContext('UserService')
      service.info('USER_CREATED', 'created', 'u_1', { plan: 'pro' })
      expect(spy).toHaveBeenCalledWith(
        { logKey: 'USER_CREATED', userId: 'u_1', context: 'UserService', plan: 'pro' },
        'created'
      )
    })

    it(/*
     * warnStructured() must route to Pino's warn level (covers the emitStructured
     * non-info branch).
     */
    'emits a structured warn entry', () => {
      const spy = jest.spyOn(rawLogger, 'warn')
      service.warnStructured('QUOTA_NEAR_LIMIT', 'almost full')
      expect(spy).toHaveBeenCalledWith(
        { logKey: 'QUOTA_NEAR_LIMIT', userId: undefined, context: undefined },
        'almost full'
      )
    })

    it(/*
     * REGRESSION — the service hands Pino the RAW thrown value and lets the
     * configured `err` serializer own the shape. Pre-serializing here is what
     * let Pino's standard serializer re-derive `type` from the resulting plain
     * object's constructor and emit `"Object"` for every typed exception, and it
     * discarded the cause chain on the way. The emitted shape is asserted where
     * it is now produced, in `pino-factory.spec.ts`.
     */
    'hands the raw error to Pino rather than a pre-serialized copy', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      const error = new Error('boom')
      service.errorStructured('PAYMENT_FAILED', error, 'u_1', { amount: 10 })
      const [payload, message] = spy.mock.calls[0] ?? []
      expect(message).toBe('boom')
      expect(payload).toMatchObject({ logKey: 'PAYMENT_FAILED', userId: 'u_1', amount: 10 })
      expect((payload as Record<string, unknown>)['err']).toBe(error)
    })

    it(/*
     * serializeError must read `error.name`, not `error.constructor.name`: a
     * sanitized plain-object error carries its real class name on `name` while
     * `constructor.name` would be the unhelpful 'Object'. Pins the err.type source.
     */
    'serializes err.type from error.name, not constructor.name', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      // The runtime value is a SanitizedError plain object (from sanitizeError),
      // which structurally satisfies `Error` — exactly how HttpExceptionFilter
      // feeds errorStructured. No cast needed; constructor.name here is 'Object'.
      const sanitized: SanitizedError = {
        name: 'ForbiddenException',
        message: 'denied',
        stack: 'stack'
      }
      service.errorStructured('HTTP_EXCEPTION_HANDLED', sanitized)
      const [payload] = spy.mock.calls[0] ?? []
      // Handed through untouched. That the SERIALIZER then reports
      // `type: 'ForbiddenException'` rather than `'Object'` is the actual
      // regression, asserted end-to-end in `pino-factory.spec.ts`.
      expect((payload as Record<string, unknown>)['err']).toBe(sanitized)
    })

    it(/*
     * Reserved structured fields must win over caller metadata — a metadata key
     * like `logKey` must NOT clobber the value passed as the logKey argument
     * (log-integrity guard against metadata-first spread regressions).
     */
    'does not let metadata override reserved info fields', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.setContext('Real')
      service.info('REAL_KEY', 'msg', 'u_1', {
        logKey: 'EVIL',
        userId: 'EVIL',
        context: 'EVIL',
        extra: 1
      })
      expect(spy).toHaveBeenCalledWith(
        { logKey: 'REAL_KEY', userId: 'u_1', context: 'Real', extra: 1 },
        'msg'
      )
    })

    it(/*
     * The same guard must hold for errorStructured: metadata must not clobber
     * logKey / userId / context / err.
     */
    'does not let metadata override reserved error fields', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.errorStructured('REAL_ERR', new Error('boom'), 'u_1', { logKey: 'EVIL', err: 'EVIL' })
      const [payload] = spy.mock.calls[0] ?? []
      expect(payload).toMatchObject({ logKey: 'REAL_ERR', userId: 'u_1' })
      // `err` holds the real thrown value, not the caller's `'EVIL'` string.
      expect((payload as Record<string, unknown>)['err']).toBeInstanceOf(Error)
    })
  })

  describe('NestJS variadic API', () => {
    it(/*
     * log() routes to info with no context when none is supplied.
     */
    'log() routes to info without a context', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.log('hello')
      expect(spy).toHaveBeenCalledWith({ context: undefined }, 'hello')
    })

    it(/*
     * The last string param must be treated as the context (nest-pino heuristic).
     */
    'treats the last string param as the context', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.log('hello', 'AppController')
      expect(spy).toHaveBeenCalledWith({ context: 'AppController' }, 'hello')
    })

    it(/*
     * A non-string message must be coerced to a string (covers the String()
     * branch).
     */
    'coerces a non-string message', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.log(42)
      expect(spy).toHaveBeenCalledWith({ context: undefined }, '42')
    })

    it(/*
     * warn/debug/verbose/fatal must map to the correct Pino levels (verbose maps
     * to trace) — covers every switch arm.
     */
    'maps warn/debug/verbose/fatal to the right levels', () => {
      const warnSpy = jest.spyOn(rawLogger, 'warn')
      const debugSpy = jest.spyOn(rawLogger, 'debug')
      const traceSpy = jest.spyOn(rawLogger, 'trace')
      const fatalSpy = jest.spyOn(rawLogger, 'fatal')
      service.warn('w')
      service.debug('d')
      service.verbose('v')
      service.fatal('f')
      expect(warnSpy).toHaveBeenCalledWith({ context: undefined }, 'w')
      expect(debugSpy).toHaveBeenCalledWith({ context: undefined }, 'd')
      expect(traceSpy).toHaveBeenCalledWith({ context: undefined }, 'v')
      expect(fatalSpy).toHaveBeenCalledWith({ context: undefined }, 'f')
    })

    it(/*
     * error(message, stack, context) must capture the stack and context from the
     * variadic params.
     */
    'error() with string params captures stack and context', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.error('failed', 'the-stack', 'PaymentController')
      expect(spy).toHaveBeenCalledWith(
        { context: 'PaymentController', stack: 'the-stack' },
        'failed'
      )
    })

    it(/*
     * error(message) without extra params must not attach a stack.
     */
    'error() without params attaches no stack', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.error('failed')
      expect(spy).toHaveBeenCalledWith({ context: undefined }, 'failed')
      // jest's argument equality ignores undefined-valued keys, so assert the
      // `stack` KEY is absent explicitly — pins the `if (stack !== undefined)`
      // guard against being forced always-true (which would add `stack:undefined`).
      expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('stack')
    })

    it(/*
     * A non-string value at the stack position (index 0) must be ignored — no
     * `stack` key may appear. Pins the `typeof optionalParams[0] === 'string'`
     * guard against being forced always-true.
     */
    'error() ignores a non-string stack argument', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.error('failed', 123 as never)
      expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('stack')
    })

    it(/*
     * A non-string, non-Error message on the variadic error() path must be
     * coerced via String() — covers the message-coercion fallback branch that the
     * log()/warn() path does not exercise.
     */
    'error() coerces a non-string message', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.error(42)
      expect(spy).toHaveBeenCalledWith({ context: undefined }, '42')
    })

    it(/*
     * error(message, stack) with no explicit context must keep the stack at
     * index 0 and fall back to the INSTANCE context — the trailing stack must
     * not be misread as the context (the positional-contract regression guard).
     */
    'error() with only a stack keeps the instance context, not the stack', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.setContext('JobRunner')
      service.error('failed', 'the-stack')
      expect(spy).toHaveBeenCalledWith({ context: 'JobRunner', stack: 'the-stack' }, 'failed')
    })

    it(/*
     * error(Error) must route to the structured error path and serialize err,
     * using the instance context.
     */
    'error(Error) routes to the structured err path', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.setContext('Boot')
      service.error(new Error('kaboom'))
      const [payload, message] = spy.mock.calls[0] ?? []
      expect(message).toBe('kaboom')
      expect(payload).toEqual({ context: 'Boot', err: expect.any(Error) })
    })

    it(/*
     * error(Error, context) must take the context from the trailing string param.
     */
    'error(Error) honors a trailing context param', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.error(new Error('kaboom'), 'JobRunner')
      const [payload] = spy.mock.calls[0] ?? []
      expect(payload).toMatchObject({ context: 'JobRunner' })
    })
  })

  describe('helpers and lifecycle', () => {
    it(/*
     * setContext() must apply the context to subsequent structured logs.
     */
    'applies setContext to later logs', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.setContext('Svc')
      service.info('K_DONE', 'done')
      expect(spy).toHaveBeenCalledWith({ logKey: 'K_DONE', context: 'Svc' }, 'done')
      // Asserted on key PRESENCE, not on `undefined`: Jest's recursive equality
      // treats `{ userId: undefined }` and `{}` as equal, so the object literal
      // above cannot distinguish "omitted" from "written as undefined" — and
      // that distinction is the whole point of the ALS clobber fix.
      expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('userId')
    })

    it(/*
     * REGRESSION — audit finding C-1, on the error path. `errorStructured` built
     * its payload the same way, so an omitted `userId` was written as `undefined`
     * and clobbered the ALS value. The context must still be attached, and the
     * omitted user must leave NO key behind for the mixin's value to be
     * overwritten by.
     */
    'attaches the context to errorStructured and omits an absent userId', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.setContext('PaymentsService')
      service.errorStructured('K_PAY_FAILED', new Error('boom'), undefined, { orderId: 'o1' })

      const [payload] = spy.mock.calls[0] ?? []
      expect(payload).toMatchObject({
        logKey: 'K_PAY_FAILED',
        context: 'PaymentsService',
        orderId: 'o1'
      })
      expect(payload).not.toHaveProperty('userId')
    })

    it(/*
     * An explicit userId on the error path must still be written — the fix must
     * not trade a clobbered value for a dropped one.
     */
    'writes an explicit userId on errorStructured', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.errorStructured('K_PAY_FAILED', new Error('boom'), 'u_9')
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ userId: 'u_9' })
    })

    it(/*
     * REGRESSION — caller `metadata` must never occupy a field the payload owns.
     * `userId` and `context` say who acted and where, and Pino merges the
     * caller's object OVER the mixin's, so a metadata bag that could land in them
     * would let a call site forge the attribution the mixin read from the
     * authenticated ALS scope. Writing the reserved fields only-when-defined
     * (the ALS clobber fix) removed the unconditional overwrite that used to
     * enforce this, so it is enforced on the way in and pinned here.
     */
    'refuses caller metadata in the fields the payload owns', () => {
      const infoSpy = jest.spyOn(rawLogger, 'info')
      const errorSpy = jest.spyOn(rawLogger, 'error')
      const forged = { userId: 'FORGED', context: 'FORGED', logKey: 'FORGED', safe: 'kept' }

      service.info('K_REAL_KEY', 'msg', undefined, forged)
      service.errorStructured('K_REAL_FAIL', new Error('boom'), undefined, forged)

      for (const spy of [infoSpy, errorSpy]) {
        const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>
        expect(payload).not.toHaveProperty('userId')
        expect(payload).not.toHaveProperty('context')
        expect(payload['logKey']).not.toBe('FORGED')
        expect(payload['safe']).toBe('kept')
      }
    })

    it(/*
     * REGRESSION — an own `__proto__` key (which is what `JSON.parse` of an
     * untrusted body produces) was copied with `Reflect.set`, and that does NOT
     * create an own property for it: the write walks the prototype chain, finds
     * `Object.prototype`'s inherited `__proto__` SETTER and invokes it. The field
     * vanished from the entry AND the copy's prototype was swapped for whatever
     * the caller sent. Dropped now, from the same constant the ALS path uses.
     */
    'drops prototype-polluting metadata keys without swapping the copy', () => {
      const infoSpy = jest.spyOn(rawLogger, 'info')
      const hostile = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":"x","prototype":"y","safe":"kept"}'
      ) as Record<string, unknown>

      service.info('K_REAL_KEY', 'msg', undefined, hostile)

      const payload = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>
      expect(payload['safe']).toBe('kept')
      expect(Object.keys(payload)).not.toContain('__proto__')
      expect(Object.keys(payload)).not.toContain('constructor')
      expect(Object.keys(payload)).not.toContain('prototype')
      // The payload must still be a plain object — the old `Reflect.set` swapped
      // its prototype for the caller's value, which is the silent half of the bug.
      expect(Object.getPrototypeOf(payload)).toBe(Object.prototype)
      // …and nothing global was touched, which is what keeps this a correctness
      // bug rather than a pollution vulnerability.
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it(/*
     * REGRESSION — the never-throw guarantee has to start at the FIRST read of
     * caller-controlled data, not at the formatter. `withoutOwnedKeys` runs
     * `Object.keys` (which fires a Proxy `ownKeys` trap) and `Reflect.get`
     * (which fires a getter) before anything reaches the redaction pipeline, so
     * hostile metadata crashed the caller outright. It must degrade to the
     * failure envelope while the entry keeps its real logKey and message.
     */
    'contains hostile metadata instead of crashing the caller', () => {
      const infoSpy = jest.spyOn(rawLogger, 'info')
      const warnSpy = jest.spyOn(rawLogger, 'warn')
      const errorSpy = jest.spyOn(rawLogger, 'error')
      const throwingGetter = {
        get boom(): never {
          throw new Error('hostile getter')
        }
      }
      const hostileProxy = new Proxy(
        {},
        {
          ownKeys(): never {
            throw new Error('hostile ownKeys')
          }
        }
      ) as Record<string, unknown>

      expect(() => service.info('K_A_B', 'msg', undefined, throwingGetter)).not.toThrow()
      expect(() => service.info('K_A_B', 'msg', undefined, hostileProxy)).not.toThrow()
      expect(() => service.warnStructured('K_A_B', 'msg', undefined, throwingGetter)).not.toThrow()
      expect(() =>
        service.errorStructured('K_A_B', new Error('boom'), undefined, throwingGetter)
      ).not.toThrow()

      for (const spy of [infoSpy, warnSpy, errorSpy]) {
        const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>
        expect(payload['_redactionFailed']).toBe(true)
        expect(payload['_logKey']).toBe('LOGGER_REDACTION_FAILED')
        // The entry survives with its real identity — only the unreadable
        // metadata is dropped.
        expect(payload['logKey']).toBe('K_A_B')
      }
    })

    it(/*
     * REGRESSION — the same class of crash on the error path, which the review
     * did not name but the probe found: `name` / `message` / `stack` are ordinary
     * properties a caller can redefine as throwing accessors, and `message` is
     * read OUTSIDE the serializer, straight into Pino's message argument.
     */
    'contains an Error whose name, message or stack throws', () => {
      const errorSpy = jest.spyOn(rawLogger, 'error')
      const hostileStack = new Error('boom')
      Object.defineProperty(hostileStack, 'stack', {
        get(): never {
          throw new Error('hostile stack')
        }
      })
      const hostileMessage = new Error('boom')
      Object.defineProperty(hostileMessage, 'message', {
        get(): never {
          throw new Error('hostile message')
        }
      })

      expect(() => service.errorStructured('K_A_B', hostileStack)).not.toThrow()
      expect(() => service.errorStructured('K_A_B', hostileMessage)).not.toThrow()
      expect(() => service.error(hostileStack)).not.toThrow()

      const [payload, message] = errorSpy.mock.calls[0] ?? []
      // The value is handed through untouched — degrading it is the SERIALIZER's
      // job now, and `pino-factory.spec.ts` asserts it degrades to the
      // `SanitizeFailed` envelope rather than throwing or emitting an empty one.
      expect((payload as Record<string, unknown>)['err']).toBe(hostileStack)
      // The guard here is targeted, not blanket: a readable message survives even
      // when the STACK is the hostile part, which is why the two cases differ.
      const [, fromHostileMessage] = errorSpy.mock.calls[1] ?? []
      expect(message).toBe('boom')
      expect(fromHostileMessage).toBe('Unreadable error message')
    })

    it(/*
     * The guard must not fire on ordinary input: a readable metadata bag still
     * reaches the record intact, with no failure marker.
     */
    'leaves readable metadata untouched', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      service.info('K_A_B', 'msg', 'u_1', { orderId: 'o_1' })
      const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>
      expect(payload).toMatchObject({ orderId: 'o_1', logKey: 'K_A_B', userId: 'u_1' })
      expect(payload).not.toHaveProperty('_redactionFailed')
    })

    it(/*
     * The strip must be surgical: a metadata key the payload does NOT own passes
     * through untouched. `err` in particular is a documented metadata field on the
     * info path (it routes through Pino's `err` serializer), so stripping it would
     * break a working pattern.
     */
    'passes through metadata keys the payload does not own', () => {
      const spy = jest.spyOn(rawLogger, 'info')
      const error = new Error('boom')
      service.info('K_A_B', 'msg', undefined, { err: error, orderId: 'o1' })
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ err: error, orderId: 'o1' })
    })

    it(/*
     * getRawLogger() must expose the underlying Pino instance.
     */
    'exposes the raw Pino instance', () => {
      expect(service.getRawLogger()).toBe(rawLogger)
    })

    it(/*
     * child() must create a child logger, propagate the parent context, and pass
     * the bindings to Pino.child (covers the context-present branch).
     */
    'child() propagates context and bindings', () => {
      const childSpy = jest.spyOn(rawLogger, 'child')
      service.setContext('Parent')
      const child = service.child({ requestId: 'r_1' })
      expect(child).toBeInstanceOf(PinoLoggerService)
      expect(childSpy).toHaveBeenCalledWith({ requestId: 'r_1' })
      const childInfoSpy = jest.spyOn(child.getRawLogger(), 'info')
      child.info('K_CHILD', 'msg')
      expect(childInfoSpy).toHaveBeenCalledWith(
        { logKey: 'K_CHILD', userId: undefined, context: 'Parent' },
        'msg'
      )
    })

    it(/*
     * child() without a parent context must not carry one over (covers the
     * context-absent branch).
     */
    'child() omits context when the parent has none', () => {
      const child = service.child({ requestId: 'r_2' })
      const childInfoSpy = jest.spyOn(child.getRawLogger(), 'info')
      child.info('K_CHILD', 'msg')
      expect(childInfoSpy).toHaveBeenCalledWith(
        { logKey: 'K_CHILD', userId: undefined, context: undefined },
        'msg'
      )
    })

    it(/*
     * onApplicationShutdown() must return undefined without throwing; DestinationRegistry
     * owns flushing so this method is intentionally a no-op.
     */
    'onApplicationShutdown returns undefined', () => {
      expect(service.onApplicationShutdown()).toBeUndefined()
    })
  })
})

describe('safeErrorMessage — log-forging neutralization', () => {
  /** Self-contained: a silent Pino instance with a spied error method. */
  function makeService(): { service: PinoLoggerService; spy: jest.SpyInstance } {
    const raw = pino({ enabled: false })
    const spy = jest.spyOn(raw, 'error').mockImplementation()
    return { service: new PinoLoggerService(raw), spy }
  }

  it(/*
   * SECURITY (CodeQL js/log-injection, alert #61) — the error message can carry
   * user-provided text, and it becomes Pino's MESSAGE argument. On the NDJSON
   * transport JSON escaping already neutralizes an embedded line break, but
   * `pino-pretty` and any destination that re-renders the parsed message print
   * real newlines — where a break forges what looks like a separate entry. The
   * message is pinned to one line at the sink.
   */
  'replaces every line separator in the message argument', () => {
    const { service, spy } = makeService()
    service.errorStructured('K_A_B', new Error('fail\nFORGED\rmore\u2028ls\u2029ps'))

    const [, message] = spy.mock.calls[0] ?? []
    expect(message).toBe('fail\\nFORGED\\nmore\\nls\\nps')
    expect(String(message)).not.toMatch(/[\r\n\u2028\u2029]/)
  })

  it(/*
   * No information is lost: the structured `err` field keeps the raw error, so
   * its verbatim message reaches the serializer — only the human-readable
   * message line is sanitized.
   */
  'keeps the structured err verbatim', () => {
    const { service, spy } = makeService()
    const error = new Error('fail\nsecond line')
    service.errorStructured('K_A_B', error)

    const [payload] = spy.mock.calls[0] ?? []
    expect((payload as Record<string, unknown>)['err']).toBe(error)
    expect(error.message).toBe('fail\nsecond line')
  })
})
