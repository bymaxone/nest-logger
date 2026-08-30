/**
 * `applyAccessLog` consumer helper — the access log mounted AHEAD of the body
 * parser, from `main.ts`.
 *
 * Layer: server/middlewares — the bootstrap-time counterpart to
 * {@link applyRequestIdMiddleware}. Both mount the same two middlewares in the
 * same order; they differ only in WHERE the mount lands in the Express stack,
 * and that difference decides an entire class of requests.
 *
 * NestJS registers the body parser one line before it registers module
 * middleware (`@nestjs/core/nest-application.js`: `registerParserMiddleware()`
 * then `registerModules()`), and Express dispatches in registration order. So
 * anything wired through `configure(consumer)` sits downstream of the parser,
 * and a body the parser rejects — `next(err)` skips every remaining non-error
 * handler — reaches no module middleware, no guard, no interceptor and no
 * handler. Measured: a `POST` with truncated JSON produced no access log at all.
 *
 * `INestApplication.use()` delegates straight to the HTTP adapter, so a handler
 * mounted here lands in the Express stack at call time — the same reason `helmet`
 * and `cookie-parser` are mounted this way.
 *
 * The boundary is **`init()`**, not `listen()`. `listen()` merely triggers `init()`
 * when it has not run yet, so "before `listen()`" is true only for the usual
 * bootstrap that never calls `init()` itself. A serverless handler or a test that
 * does `await app.init()` and mounts afterwards is already behind the parser.
 *
 * {@link HttpAccessLogMiddleware} needed no new logic to work there: it emits
 * from the response's `'close'` event, so it never depends on a route matching,
 * a handler running or a filter catching anything.
 *
 * Full rationale, and the table of what each wiring emits today, is in the
 * README under "Requests rejected before routing".
 */
import type { INestApplication } from '@nestjs/common'

import { HttpAccessLogMiddleware } from './http-access-log.middleware'
import { RequestIdMiddleware } from './request-id.middleware'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

/** The providers the two middlewares are constructed from. */
interface AccessLogDependencies {
  /** Sink for the access-log entries. */
  readonly logger: PinoLoggerService
  /** The AsyncLocalStorage-backed correlation scope. */
  readonly logContext: LogContextService
  /** Resolved module options, read for `http.*`. */
  readonly options: ResolvedBymaxLoggerModuleOptions
}

/**
 * Pull the middlewares' dependencies out of the application container.
 *
 * The middlewares are constructed by hand rather than resolved as providers:
 * NestJS only instantiates a middleware class that some module's
 * `configure(consumer)` applied, and the whole point here is to mount without
 * going through that path. Every dependency is already exported by the module,
 * so nothing private is reached into.
 *
 * The lookup is deliberately unqualified. `NestApplicationContext.get` searches
 * the whole module graph unless `strict` is set, and `strict` only narrows to
 * `contextModule`, which is populated by `select()` — whose return type is
 * `INestApplicationContext`, not the `INestApplication` this takes. So the whole
 * graph is searched for every value this parameter can hold, and the logger
 * module resolves whether or not it was registered with `isGlobal: true`.
 * Passing `{ strict: false }` explicitly would restate the signature default and
 * assert a distinction that cannot arise here.
 *
 * @param app - The Nest application, after `NestFactory.create()`.
 * @returns The resolved logger, context service and options.
 * @throws Error When `BymaxLoggerModule` was not imported — a clear message
 *   instead of a cryptic DI failure, with the original error kept as `cause`.
 */
function resolveDependencies(app: INestApplication): AccessLogDependencies {
  try {
    return {
      logger: app.get(PinoLoggerService),
      logContext: app.get(LogContextService),
      options: app.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN)
    }
  } catch (cause) {
    throw new Error(
      '[BymaxLoggerModule] applyAccessLog(app) called but BymaxLoggerModule was not imported',
      { cause }
    )
  }
}

/**
 * Mount the correlation scope and the HTTP access log ahead of the body parser.
 *
 * Call AFTER `NestFactory.create()` and BEFORE the application initializes —
 * that is, before `app.init()`, or before `app.listen()` in the usual bootstrap
 * that never calls `init()` directly.
 *
 * **`init()` is the real deadline, and `listen()` is only where most bootstraps
 * meet it.** A serverless entry point or an integration test typically does
 * `await app.init()` and then wires things up; mounting there still mounts, but
 * BEHIND the parser, which forfeits the entire reason to use this helper — the
 * parser-rejected request goes unlogged exactly as before, with no error to say
 * so. The mount is not rejected when it is late because NestJS exposes no
 * supported signal for "already initialized" — `isInitialized` is private, and
 * reaching into the adapter's router to guess would break on a NestJS patch
 * release while claiming to be a safety net.
 *
 * The ordering is the one thing to get right here, so it is worth a glance at
 * the call site rather than trust: mount it immediately after `NestFactory.create()`.
 *
 * Requires `http.isEnabled` for the access log itself; with HTTP logging off the
 * correlation scope is still opened (matching `applyRequestIdMiddleware`) and no
 * access entries are written.
 *
 * @param app - The Nest application returned by `NestFactory.create()`.
 * @throws Error When `BymaxLoggerModule` was not imported.
 * @example
 *   import { BymaxLoggerModule, applyAccessLog } from '@bymax-one/nest-logger'
 *
 *   const app = await NestFactory.create(AppModule, { bufferLogs: true })
 *   BymaxLoggerModule.useNestLogger(app)
 *   applyAccessLog(app) // before init(): listen() triggers it if you have not
 *   await app.listen(3000)
 */
export function applyAccessLog(app: INestApplication): void {
  const { logger, logContext, options } = resolveDependencies(app)
  const requestId = new RequestIdMiddleware(logContext, options)
  const accessLog = new HttpAccessLogMiddleware(logger, logContext, options)

  // Nested rather than two `app.use()` calls: the access log MUST run inside the
  // correlation scope `RequestIdMiddleware` opens, or its entries carry no
  // `requestId` and no trace context. Two separate mounts would also run in
  // order, but nesting states the dependency at the point it matters instead of
  // leaving it to the reader to infer from the call sequence.
  app.use((req: LoggableRequest, res: LoggableResponse, next: NextHandler): void => {
    requestId.use(req, res, () => {
      accessLog.use(req, res, next)
    })
  })
}
