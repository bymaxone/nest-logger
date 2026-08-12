import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, LogContextService, PinoLoggerService } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

/**
 * End-to-end coverage for AsyncLocalStorage context reaching a SERIALIZED entry.
 *
 * The gap this file closes: every previous test asserted the ALS store in
 * isolation (`LogContextService` unit specs) or asserted `requestId` on an HTTP
 * entry. Nothing asserted that a field placed in the store arrives in the log
 * record — so the `userId` clobber survived a 100 % line-coverage gate and a
 * 97 % mutation score. Line coverage proved the code ran; nothing proved the
 * value crossed the ALS → mixin → Pino → sink boundary.
 */
describe('Logger E2E — ALS context propagation', () => {
  let app: INestApplication | undefined
  let stdoutSpy: jest.SpyInstance
  let logger: PinoLoggerService
  let logContext: LogContextService

  beforeEach(async () => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service: { name: 'e2e-context', version: '0.0.0' } })]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    logger = app.get(PinoLoggerService, { strict: false })
    logContext = app.get(LogContextService, { strict: false })
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  /** Find the parsed entry carrying the given logKey. */
  function findEntry(logKey: string): Record<string, unknown> | undefined {
    return parseLogEntries(stdoutSpy).find((entry) => entry['logKey'] === logKey)
  }

  it(/*
   * REGRESSION — audit finding C-1. `emitStructured` wrote `userId: undefined`
   * as an own property whenever the argument was omitted, and Pino's default
   * `mixinMergeStrategy` (`Object.assign(mixinResult, mergeObject)`) let that
   * `undefined` overwrite the value the trace mixin had just read from the ALS
   * store. The key then vanished during serialization, so the documented
   * "set the user once per request" pattern silently produced nothing.
   */
  'carries an ALS userId into a structured entry when the argument is omitted', () => {
    logContext.run({ requestId: 'r_1', tenantId: 't_1', userId: 'u_als' }, () => {
      logger.info('CONTEXT_INFO', 'probe')
    })

    const entry = findEntry('CONTEXT_INFO')
    expect(entry?.['userId']).toBe('u_als')
    expect(entry?.['requestId']).toBe('r_1')
    expect(entry?.['tenantId']).toBe('t_1')
  })

  it(/*
   * The same clobber applied to every structured emitter, not just `info` —
   * `warnStructured` and `errorStructured` build the payload the same way.
   */
  'carries an ALS userId into warn and error entries', () => {
    logContext.run({ userId: 'u_als' }, () => {
      logger.warnStructured('CONTEXT_WARN', 'probe')
      logger.errorStructured('CONTEXT_ERROR', new Error('boom'))
    })

    expect(findEntry('CONTEXT_WARN')?.['userId']).toBe('u_als')
    expect(findEntry('CONTEXT_ERROR')?.['userId']).toBe('u_als')
  })

  it(/*
   * Precedence is explicit-argument > ALS. A call site that names the acting
   * user must still win over the ambient one — otherwise fixing the clobber
   * would have traded one wrong value for another.
   */
  'lets an explicit userId argument win over the ALS value', () => {
    logContext.run({ userId: 'u_als' }, () => {
      logger.info('CONTEXT_OVERRIDE', 'probe', 'u_explicit')
    })

    expect(findEntry('CONTEXT_OVERRIDE')?.['userId']).toBe('u_explicit')
  })

  it(/*
   * `context` was clobbered by the same mechanism on the NestJS-variadic path:
   * `emitNestStyle` wrote `context: undefined` when neither a trailing string
   * nor an instance context was present, erasing an ambient one.
   */
  'carries an ALS context through the NestJS variadic path', () => {
    logContext.run({ context: 'AmbientContext', requestId: 'r_2' }, () => {
      logger.log('plain nest-style message')
    })

    const entry = parseLogEntries(stdoutSpy).find(
      (candidate) => candidate['msg'] === 'plain nest-style message'
    )
    expect(entry?.['context']).toBe('AmbientContext')
    expect(entry?.['requestId']).toBe('r_2')
  })

  it(/*
   * A field added mid-scope with `set()` — the documented way to attach the
   * authenticated user after a guard has run — must reach the record too.
   */
  'carries a field added mid-scope with set()', () => {
    logContext.run({ requestId: 'r_3' }, () => {
      logContext.set('userId', 'u_late')
      logContext.set('sessionId', 's_1')
      logger.info('CONTEXT_SET', 'probe')
    })

    const entry = findEntry('CONTEXT_SET')
    expect(entry?.['userId']).toBe('u_late')
    expect(entry?.['sessionId']).toBe('s_1')
  })

  it(/*
   * Context must survive a nested async chain — a timer, an awaited promise and
   * a microtask — because that is what a real request handler looks like. ALS
   * propagates through native async hooks, but nothing pinned it end-to-end.
   */
  'survives nested async operations inside one scope', async () => {
    await logContext.run({ requestId: 'r_async', userId: 'u_async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await Promise.resolve()
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve)
      })
      logger.info('CONTEXT_ASYNC', 'probe')
    })

    const entry = findEntry('CONTEXT_ASYNC')
    expect(entry?.['requestId']).toBe('r_async')
    expect(entry?.['userId']).toBe('u_async')
  })

  it(/*
   * Concurrent scopes must not bleed into one another. Each iteration logs after
   * a jittered await, so the scopes are genuinely interleaved rather than run to
   * completion one at a time — the shape that would expose a shared-store leak.
   */
  'keeps concurrent scopes isolated', async () => {
    const count = 50
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        logContext.run({ requestId: `r_${index}`, userId: `u_${index}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, (index % 5) + 1))
          logger.info('CONTEXT_CONCURRENT', 'probe', undefined, { expected: index })
        })
      )
    )

    const entries = parseLogEntries(stdoutSpy).filter(
      (entry) => entry['logKey'] === 'CONTEXT_CONCURRENT'
    )
    expect(entries).toHaveLength(count)
    for (const entry of entries) {
      expect(entry['requestId']).toBe(`r_${String(entry['expected'])}`)
      expect(entry['userId']).toBe(`u_${String(entry['expected'])}`)
    }
  })

  it(/*
   * Outside any scope the fields must simply be absent — the fix must not start
   * emitting empty or null correlation keys, which would pollute every log a
   * worker or a CLI writes.
   */
  'omits context fields entirely outside any scope', () => {
    logger.info('CONTEXT_NONE', 'probe')

    const entry = findEntry('CONTEXT_NONE')
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('userId')
    expect(entry).not.toHaveProperty('requestId')
    expect(entry).not.toHaveProperty('context')
  })
})
