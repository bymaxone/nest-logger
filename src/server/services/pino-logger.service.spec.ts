import pino from 'pino'
import type { Logger } from 'pino'

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
     * errorStructured() must serialize the Error into name/message/stack.
     */
    'emits a structured error entry with a serialized err', () => {
      const spy = jest.spyOn(rawLogger, 'error')
      service.errorStructured('PAYMENT_FAILED', new Error('boom'), 'u_1', { amount: 10 })
      const [payload, message] = spy.mock.calls[0] ?? []
      expect(message).toBe('boom')
      expect(payload).toMatchObject({
        logKey: 'PAYMENT_FAILED',
        userId: 'u_1',
        amount: 10,
        err: { name: 'Error', message: 'boom' }
      })
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
      expect(payload).toMatchObject({
        logKey: 'REAL_ERR',
        userId: 'u_1',
        err: { name: 'Error', message: 'boom' }
      })
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
      expect(payload).toEqual({
        context: 'Boot',
        err: { name: 'Error', message: 'kaboom', stack: expect.any(String) }
      })
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
      expect(spy).toHaveBeenCalledWith(
        { logKey: 'K_DONE', userId: undefined, context: 'Svc' },
        'done'
      )
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
     * onApplicationShutdown() must resolve without throwing (no-op until Phase 4).
     */
    'onApplicationShutdown resolves', async () => {
      await expect(service.onApplicationShutdown()).resolves.toBeUndefined()
    })
  })
})
