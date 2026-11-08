/**
 * `applyRequestContext` — the correlation scope mounted AHEAD of the body parser, from `main.ts`.
 *
 * Layer: server/middlewares. NestJS registers the body parser one step before module middleware,
 * and Express dispatches in registration order, so a request the parser refuses (malformed JSON,
 * an unsupported content encoding, a body over the limit) never reaches a middleware mounted through
 * `configure(consumer)`. An exception filter then answers it outside any correlation scope, and
 * its envelope cannot carry the request id. `INestApplication.use()` lands in the Express stack at
 * call time, so a handler mounted before `init()` runs ahead of the parser.
 *
 * Only the scope is mounted here. Mounting `applyAccessLog` or `applyRequestIdMiddleware` as well
 * is safe: `RequestIdMiddleware` opens one scope per request and a second mount reuses it.
 */
import type { INestApplication } from '@nestjs/common'

import { RequestIdMiddleware } from './request-id.middleware'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'

/**
 * Mount the request-id middleware ahead of the body parser.
 *
 * Call AFTER `NestFactory.create()` and BEFORE the application initializes (`app.init()`, or
 * `app.listen()` when `init()` is not called directly): a later mount lands behind the parser and
 * forfeits the reason to call it.
 *
 * @param app - The Nest application returned by `NestFactory.create()`.
 * @throws Error When `BymaxLoggerModule` was not imported, with the DI error as `cause`.
 */
export function applyRequestContext(app: INestApplication): void {
  let requestId: RequestIdMiddleware
  try {
    requestId = new RequestIdMiddleware(
      app.get(LogContextService),
      app.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN)
    )
  } catch (cause) {
    throw new Error(
      '[BymaxLoggerModule] useRequestContext(app) called but BymaxLoggerModule was not imported',
      { cause }
    )
  }
  app.use((req: LoggableRequest, res: LoggableResponse, next: NextHandler): void => {
    requestId.use(req, res, next)
  })
}
