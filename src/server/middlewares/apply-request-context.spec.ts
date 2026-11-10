/**
 * Pins `applyRequestContext`, which `BymaxLoggerModule.useRequestContext` delegates to: it mounts
 * one handler on the application that opens the correlation scope, a second mount of the same
 * middleware reuses that scope, and calling it without the module imported fails with a clear
 * message. The application is a double with `get` and `use`; that the handler runs ahead of the
 * body parser is pinned in `test/e2e/use-request-context.e2e-spec.ts`, which boots Nest.
 *
 * Layer: server/middlewares, tests.
 */
import type { INestApplication } from '@nestjs/common'

import { applyRequestContext } from './apply-request-context'
import { RequestIdMiddleware } from './request-id.middleware'
import { applyDefaults } from '../config/default-options'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'

type Handler = (req: LoggableRequest, res: LoggableResponse, next: NextHandler) => void

/** An application that hands out the module's providers and records what is mounted on it. */
function appWith(logContext: LogContextService): {
  app: INestApplication
  mounted: Handler[]
  options: ReturnType<typeof applyDefaults>
} {
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const mounted: Handler[] = []
  const app = {
    get: (token: unknown) => (token === LOGGER_OPTIONS_TOKEN ? options : logContext),
    use: (handler: Handler) => void mounted.push(handler)
  } as unknown as INestApplication
  return { app, mounted, options }
}

const request = (headers: Record<string, string> = {}): LoggableRequest =>
  ({ headers, method: 'POST', url: '/echo' }) as unknown as LoggableRequest

const response = (): { res: LoggableResponse; headers: Record<string, string> } => {
  const headers: Record<string, string> = {}
  const res = {
    setHeader: (name: string, value: string): void => void (headers[name] = value)
  } as unknown as LoggableResponse
  return { res, headers }
}

describe('applyRequestContext', () => {
  it('is what BymaxLoggerModule.useRequestContext mounts', () => {
    const { app, mounted } = appWith(new LogContextService())

    BymaxLoggerModule.useRequestContext(app)

    expect(mounted).toHaveLength(1)
  })

  it('mounts exactly one handler on the application', () => {
    const { app, mounted } = appWith(new LogContextService())

    applyRequestContext(app)

    expect(mounted).toHaveLength(1)
  })

  it('opens the scope for a request: the id is in the context of what runs next and on the response', () => {
    const logContext = new LogContextService()
    const { app, mounted } = appWith(logContext)
    applyRequestContext(app)
    const { res, headers } = response()
    let seen: unknown

    mounted[0]?.(request(), res, () => {
      seen = logContext.get('requestId')
    })

    expect(seen).toEqual(expect.any(String))
    expect(headers['x-request-id']).toBe(seen)
  })

  it('keeps the id a caller sent, as the module-level mount does', () => {
    const logContext = new LogContextService()
    const { app, mounted } = appWith(logContext)
    applyRequestContext(app)
    const { res, headers } = response()
    let seen: unknown

    mounted[0]?.(request({ 'x-request-id': 'caller-id-1' }), res, () => {
      seen = logContext.get('requestId')
    })

    expect(headers['x-request-id']).toBe('caller-id-1')
    expect(seen).toBe('caller-id-1')
  })

  it('is reused by a second mount of the middleware, which mints no second id', () => {
    const logContext = new LogContextService()
    const { app, mounted, options } = appWith(logContext)
    applyRequestContext(app)
    const second = new RequestIdMiddleware(logContext, options)
    const req = request()
    const { res, headers } = response()
    const ids: unknown[] = []

    mounted[0]?.(req, res, () => {
      ids.push(logContext.get('requestId'))
      second.use(req, res, () => ids.push(logContext.get('requestId')))
    })

    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(headers['x-request-id']).toBe(ids[0])
  })

  it('writes nothing to the real stdout', () => {
    const stdout = jest.spyOn(process.stdout, 'write')
    const { app, mounted } = appWith(new LogContextService())
    applyRequestContext(app)

    const next = jest.fn()

    mounted[0]?.(request(), response().res, next)

    expect(next).toHaveBeenCalledTimes(1)

    expect(stdout).not.toHaveBeenCalled()
    stdout.mockRestore()
  })

  it('throws a clear error, with the DI failure as the cause, when the module is not imported', () => {
    const failure = new Error('Nest could not find LogContextService')
    const app = {
      get: (): never => {
        throw failure
      },
      use: jest.fn()
    } as unknown as INestApplication

    expect(() => applyRequestContext(app)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('useRequestContext(app) called but BymaxLoggerModule'),
        cause: failure
      })
    )
    expect(app.use).not.toHaveBeenCalled()
  })
})
