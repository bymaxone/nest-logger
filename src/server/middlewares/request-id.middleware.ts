/**
 * Request correlation middleware.
 *
 * Layer: server/middlewares — opens an {@link LogContextService} scope per HTTP
 * request so every downstream log (and the Pino trace mixin) inherits the
 * request's `requestId` and optional `tenantId`. Runs before guards and
 * interceptors, which is exactly where the correlation scope must start.
 *
 * Express-only (`@nestjs/platform-express`). A Fastify adapter is not currently
 * supported.
 */
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'

import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { LogContext } from '../interfaces/log-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'

/** Response/request header carrying the correlation id. */
const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Upper bound on an accepted correlation/tenant header value. Generous enough
 * for any real id format (UUID, ULID, trace id, slug) while preventing a
 * client-controlled string of unbounded size from being propagated into every
 * log entry for the request's lifetime.
 */
const MAX_CORRELATION_ID_LENGTH = 256

/**
 * Characters an accepted correlation/tenant id may contain: the union every real
 * id format needs — hex and alphanumerics, plus the punctuation of UUID/ULID
 * (`-`), W3C traceparent (`-`), dotted ids (`.`), namespaced ids (`:`, `/`) and
 * base64url/base64 (`_`, `+`, `/`, `=`). A single character class with `+`, so it
 * scans linearly and carries no backtracking question.
 *
 * The point is what it EXCLUDES: control characters, whitespace, and the HTML
 * metacharacters `< > " '`. The value is echoed back verbatim on the `x-request-id`
 * response header and stored as `requestId` in the per-request log context, so it
 * reaches every log entry the request produces. Confining it to id-safe characters
 * keeps a client from planting a control byte or markup fragment in the logs and the
 * response header of every request it makes.
 */
const CORRELATION_ID_CHARSET = /^[A-Za-z0-9._:/+=-]+$/

/**
 * Whether a raw header value is an acceptable correlation/tenant id: a non-empty
 * string within the length bound and drawn only from {@link CORRELATION_ID_CHARSET}.
 * Anything else — a non-string, an oversized value, or one carrying a character
 * outside the id-safe set — is rejected so the caller falls back to a generated
 * id (or omits the field).
 *
 * @param value - The raw header value (anything).
 * @returns `true` when `value` is an id-safe string within the bound.
 */
function isAcceptableHeaderValue(value: unknown): value is string {
  // No explicit non-empty check: {@link CORRELATION_ID_CHARSET} is anchored with `+`, so it
  // already rejects the empty string, and a redundant `length >= 1` would only be untestable.
  return (
    typeof value === 'string' &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    CORRELATION_ID_CHARSET.test(value)
  )
}

/**
 * Reads (or generates) the correlation id and starts the per-request log
 * context scope.
 *
 * @example
 *   // Wire it in the consumer's AppModule:
 *   export class AppModule implements NestModule {
 *     configure(consumer: MiddlewareConsumer): void {
 *       applyRequestIdMiddleware(consumer)
 *     }
 *   }
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  /** Header name carrying the tenant id, resolved from module options. */
  private readonly tenantIdHeader: string
  /** Whether to mint a `requestId` when the inbound header is absent. */
  private readonly shouldGenerateRequestId: boolean

  /**
   * @param logContext - The AsyncLocalStorage-backed context service. Injected by
   *   token explicitly: the package is bundled without `emitDecoratorMetadata`,
   *   so implicit class-type injection would not resolve.
   * @param options - Resolved module options (read for `http.tenantIdHeader` and
   *   `http.shouldGenerateRequestId`).
   */
  constructor(
    @Inject(LogContextService) private readonly logContext: LogContextService,
    @Inject(LOGGER_OPTIONS_TOKEN) options: ResolvedBymaxLoggerModuleOptions
  ) {
    this.tenantIdHeader = options.http.tenantIdHeader
    this.shouldGenerateRequestId = options.http.shouldGenerateRequestId
  }

  /**
   * Echo or mint the `x-request-id`, expose it on the response, and run the
   * remainder of the request inside its own log-context scope.
   *
   * Idempotent: mounting this middleware twice on the same request mints one id,
   * not two. The scope is opened with `runMerged`, so an enclosing scope's fields
   * are carried in rather than discarded, and the request still gets its own
   * store rather than writing into a shared one.
   *
   * The one shape this cannot tell apart is an enclosing scope that already
   * carries a `requestId` and outlives a single request — a correlation id set
   * outside any request, which the second mount would then adopt for every
   * request. Set `requestId` per request, which is what this middleware and
   * `LogContextService` both assume.
   *
   * @param req - The incoming request (Express satisfies the contract).
   * @param res - The outgoing response (Express satisfies the contract).
   * @param next - The next handler in the chain.
   */
  use(req: LoggableRequest, res: LoggableResponse, next: NextHandler): void {
    const existingRequestId = this.logContext.getStore()?.requestId
    // A correlation id is ALREADY in scope, so this is a second mount of this
    // middleware on the same request — `applyAccessLog(app)` in `main.ts`
    // alongside `applyRequestIdMiddleware(consumer)` is the wiring that produces
    // it, and a reasonable one to hold while migrating between the two.
    //
    // Adopt it rather than minting again. A fresh mint here would put a second,
    // different id on a request that already has one, leaving the response header
    // and the log entries disagreeing about the request's identity — each answer
    // internally consistent, which is why the defect survived: nothing looks
    // broken from either side alone.
    if (existingRequestId !== undefined) {
      this.adoptExistingScope(existingRequestId, req, res)
      next()
      return
    }

    const context: LogContext = {}
    const requestId = this.resolveRequestId(req)
    if (requestId !== undefined) {
      res.setHeader(REQUEST_ID_HEADER, requestId)
      context.requestId = requestId
    }
    const tenantId = this.resolveTenantId(req)
    if (tenantId !== undefined) {
      context.tenantId = tenantId
    }

    // `runMerged`, not `run`, and the difference is load-bearing twice over.
    //
    // It carries an enclosing scope's fields INTO the request scope, where plain
    // `run()` would discard them: a consumer that resolves a tenant at the edge
    // and opens its own scope would otherwise lose it for the whole request,
    // silently — `get()` just returns `undefined`.
    //
    // And it opens a NEW store rather than writing into the enclosing one, which
    // is what keeps requests isolated. Measured on the version that enriched an
    // enclosing scope in place: with the server created inside a `run()` scope —
    // every request handler then inherits that store — two sequential requests
    // were handed the SAME `requestId`, and the shared store kept the first
    // request's id after both finished. Correlation that silently merges two
    // requests is worse than none, because it is trusted.
    this.logContext.runMerged(context, () => next())
  }

  /**
   * Second mount on a request that already carries a correlation id: echo the id
   * onto the response and fill in a tenant the scope does not have yet, without
   * opening another scope.
   *
   * Nothing is minted and nothing already set is overwritten, so a third mount —
   * or a thirtieth — changes nothing. The response header is written on every
   * pass because the enclosing scope may have been opened by consumer code that
   * never exposed it.
   *
   * @param requestId - The id already in scope, which wins.
   * @param req - The incoming request, read for the tenant header.
   * @param res - The outgoing response, where the effective id is exposed.
   */
  private adoptExistingScope(requestId: string, req: LoggableRequest, res: LoggableResponse): void {
    res.setHeader(REQUEST_ID_HEADER, requestId)
    if (this.logContext.get('tenantId') === undefined) {
      const tenantId = this.resolveTenantId(req)
      if (tenantId !== undefined) {
        this.logContext.set('tenantId', tenantId)
      }
    }
  }

  /**
   * The correlation id for this request: the inbound header when acceptable,
   * otherwise a fresh UUID — or nothing at all when `shouldGenerateRequestId` is
   * off and the caller sent none, which leaves correlation to the upstream
   * gateway.
   *
   * @param req - The incoming request.
   * @returns The id, or `undefined` when none is available and none is minted.
   */
  private resolveRequestId(req: LoggableRequest): string | undefined {
    // `Reflect.get` keeps the header lookup off the
    // `security/detect-object-injection` sink list (the name is a named
    // constant, not an inline literal).
    const incoming: unknown = Reflect.get(req.headers, REQUEST_ID_HEADER)
    const fromHeader = isAcceptableHeaderValue(incoming) ? incoming : undefined
    return fromHeader ?? (this.shouldGenerateRequestId ? randomUUID() : undefined)
  }

  /**
   * The tenant id carried by the configured header, when it is acceptable.
   *
   * Never minted: a tenant is an assertion about who the request belongs to, and
   * inventing one would be a fabricated claim rather than a correlation aid.
   *
   * @param req - The incoming request.
   * @returns The tenant id, or `undefined`.
   */
  private resolveTenantId(req: LoggableRequest): string | undefined {
    // `Reflect.get` keeps the lookup off the `security/detect-object-injection`
    // sink list (the name is runtime configuration, not an inline literal).
    const raw: unknown = Reflect.get(req.headers, this.tenantIdHeader)
    return isAcceptableHeaderValue(raw) ? raw : undefined
  }
}
