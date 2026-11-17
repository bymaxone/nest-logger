/**
 * Verifies the merge of the mixin result with the caller's object: a key the mixin writes (the
 * request context, the trace fields) is the mixin's value whatever the caller's object carries, a
 * key the mixin leaves undefined does not erase the caller's own value, a key only the caller has is
 * kept, and an object that cannot be read is dropped whole while the mixin's keys stay.
 *
 * Layer: server, tests. Driven through the real factory, so the assertions are on the line a
 * destination receives.
 */
import { applyDefaults } from './config/default-options'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'

function createPipeline(): {
  logContext: LogContextService
  log(payload: object): Record<string, unknown>
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const logContext = new LogContextService()
  const pino = buildPinoInstance(
    applyDefaults({ service: { name: 'app', version: '1.0.0' } }),
    logContext,
    [destination],
    new DestinationHealth()
  )
  return {
    logContext,
    log: (payload) => {
      pino.info(payload, 'text')
      return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
    }
  }
}

describe('the merge of the mixin result with the caller object', () => {
  it('keeps the request context values over the same keys in the object', () => {
    const { logContext, log } = createPipeline()

    const entry = logContext.run({ requestId: 'req-real', tenantId: 'tenant-real' }, () =>
      log({ requestId: 'forged', tenantId: 'forged', attempts: 3 })
    )

    expect(entry).toMatchObject({ requestId: 'req-real', tenantId: 'tenant-real', attempts: 3 })
  })

  it('keeps the userId a call names over the one of the request context', () => {
    const { logContext, log } = createPipeline()

    const entry = logContext.run({ requestId: 'req-real', userId: 'u_als' }, () =>
      log({ userId: 'u_explicit' })
    )

    expect(entry).toMatchObject({ requestId: 'req-real', userId: 'u_explicit' })
  })

  it('writes the userId of the request context when the call names none', () => {
    const { logContext, log } = createPipeline()

    const entry = logContext.run({ userId: 'u_als' }, () => log({ attempts: 3 }))

    expect(entry).toMatchObject({ userId: 'u_als' })
  })

  it('keeps the object value for a key the context holds as undefined', () => {
    const { logContext, log } = createPipeline()

    const entry = logContext.run({ requestId: 'req-real', tenantId: undefined } as never, () =>
      log({ tenantId: 'from-object' })
    )

    expect(entry).toMatchObject({ requestId: 'req-real', tenantId: 'from-object' })
  })

  it('keeps the object value for a key the context does not hold', () => {
    const { log } = createPipeline()

    expect(log({ requestId: 'job-7' })).toMatchObject({ requestId: 'job-7' })
  })

  it('drops an object that cannot be read and keeps the context keys', () => {
    const { logContext, log } = createPipeline()
    const hostile = {
      get boom(): string {
        throw new Error('getter')
      }
    }

    const entry = logContext.run({ requestId: 'req-real' }, () => log(hostile))

    expect(entry).toMatchObject({ requestId: 'req-real', _redactionFailed: true })
  })
})
