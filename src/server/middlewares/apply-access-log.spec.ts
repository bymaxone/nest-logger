/**
 * Pins `applyAccessLog`: it mounts one handler on the application, that handler opens the
 * correlation scope and runs the access log INSIDE it, the dependencies are looked up without a
 * strict qualifier, and calling it without the module imported fails with a clear message that
 * keeps the DI failure as its cause. The application is a double with `get` and `use`; that the
 * handler runs ahead of the body parser, under a global prefix and with a non-global logger
 * module, is pinned in `test/e2e/apply-access-log.e2e-spec.ts`, which boots Nest.
 *
 * Layer: server/middlewares, tests.
 */
import { EventEmitter } from 'node:events'

import type { INestApplication } from '@nestjs/common'

import { applyAccessLog } from './apply-access-log'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import { applyDefaults } from '../config/default-options'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

type Handler = (req: LoggableRequest, res: LoggableResponse, next: NextHandler) => void

/** An application that hands out the module's providers and records what is mounted on it. */
function appWith(http: BymaxLoggerModuleOptions['http'] = { isEnabled: true }): {
  app: INestApplication
  mounted: Handler[]
  get: jest.Mock
  logger: { info: jest.Mock; warnStructured: jest.Mock; errorStructured: jest.Mock }
  logContext: LogContextService
} {
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, http })
  const logContext = new LogContextService()
  const logger = { info: jest.fn(), warnStructured: jest.fn(), errorStructured: jest.fn() }
  const mounted: Handler[] = []
  const get = jest.fn((token: unknown) => {
    if (token === PinoLoggerService) return logger
    if (token === LOGGER_OPTIONS_TOKEN) return options
    return logContext
  })
  const app = {
    get,
    use: (handler: Handler) => void mounted.push(handler)
  } as unknown as INestApplication
  return { app, mounted, get, logger, logContext }
}

const request = (headers: Record<string, string> = {}): LoggableRequest =>
  ({
    headers,
    method: 'POST',
    url: '/examples',
    originalUrl: '/examples'
  }) as unknown as LoggableRequest

/** A response that can be closed, with the status and the delivery state the terminal entry reads. */
function response(statusCode = 201): {
  res: LoggableResponse
  headers: Record<string, string>
  close: () => void
} {
  const headers: Record<string, string> = {}
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    statusCode,
    writableFinished: true,
    setHeader: (name: string, value: string): void => void (headers[name] = value)
  }) as unknown as LoggableResponse
  return { res, headers, close: () => void emitter.emit('close') }
}

describe('applyAccessLog', () => {
  it('mounts exactly one handler on the application', () => {
    const { app, mounted } = appWith()

    applyAccessLog(app)

    expect(mounted).toHaveLength(1)
  })

  it('looks its dependencies up without a strict qualifier', () => {
    const { app, get } = appWith()

    applyAccessLog(app)

    expect(get).toHaveBeenCalledWith(PinoLoggerService)
    expect(get).toHaveBeenCalledWith(LogContextService)
    expect(get).toHaveBeenCalledWith(LOGGER_OPTIONS_TOKEN)
  })

  it('logs START inside the correlation scope the request id opens, and echoes that id', () => {
    const { app, mounted, logger, logContext } = appWith()
    applyAccessLog(app)
    const seen: unknown[] = []
    logger.info.mockImplementation(() => void seen.push(logContext.get('requestId')))
    const { res, headers } = response()
    const next = jest.fn()

    mounted[0]?.(request({ 'x-request-id': 'measure-me' }), res, next)

    expect(logger.info).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      'POST /examples',
      undefined,
      expect.objectContaining({ method: 'POST', url: '/examples', fullUrl: '/examples' })
    )
    expect(seen).toEqual(['measure-me'])
    expect(headers['x-request-id']).toBe('measure-me')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('runs what comes next inside the scope, after START', () => {
    const { app, mounted, logger, logContext } = appWith()
    applyAccessLog(app)
    const order: string[] = []
    logger.info.mockImplementation(() => void order.push('start'))
    const { res } = response()

    mounted[0]?.(request(), res, () => {
      order.push(`next:${typeof logContext.get('requestId')}`)
    })

    expect(order).toEqual(['start', 'next:string'])
  })

  it('logs the terminal entry with the real status when the response closes', () => {
    const { app, mounted, logger } = appWith()
    applyAccessLog(app)
    const { res, close } = response(201)
    mounted[0]?.(request(), res, () => undefined)
    logger.info.mockClear()

    close()

    expect(logger.info).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS,
      expect.stringContaining('POST /examples → 201'),
      undefined,
      expect.objectContaining({ statusCode: 201 })
    )
  })

  it('logs a 4xx terminal entry for a request refused before any route', () => {
    const { app, mounted, logger } = appWith()
    applyAccessLog(app)
    const { res, close } = response(400)
    mounted[0]?.(request(), res, () => undefined)

    close()

    expect(logger.warnStructured).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
      'POST /examples → 400',
      undefined,
      expect.objectContaining({ statusCode: 400 })
    )
  })

  it('opens the scope and writes no access entry when HTTP logging is off', () => {
    const { app, mounted, logger, logContext } = appWith({ isEnabled: false })
    applyAccessLog(app)
    let seen: unknown
    const { res, headers, close } = response()

    mounted[0]?.(request(), res, () => {
      seen = logContext.get('requestId')
    })
    close()

    expect(seen).toEqual(expect.any(String))
    expect(headers['x-request-id']).toBe(seen)
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warnStructured).not.toHaveBeenCalled()
  })

  it('throws a clear error naming the cause when BymaxLoggerModule was not imported', () => {
    const failure = new Error('Nest could not find PinoLoggerService')
    const app = {
      get: (): never => {
        throw failure
      },
      use: jest.fn()
    } as unknown as INestApplication
    let caught: unknown

    try {
      applyAccessLog(app)
    } catch (error) {
      caught = error
    }

    // Equality rather than `toThrow`, which substring-matches a string and would still pass if
    // the cryptic DI failure this helper replaces were prepended to the clear one.
    expect((caught as Error).message).toBe(
      '[BymaxLoggerModule] applyAccessLog(app) called but BymaxLoggerModule was not imported'
    )
    expect((caught as Error).cause).toBe(failure)
    expect(app.use).not.toHaveBeenCalled()
  })
})
