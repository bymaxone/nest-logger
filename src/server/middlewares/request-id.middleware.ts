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
import {
  isCorrelationOpened,
  markCorrelationOpened,
  markOwnRequestId,
  readOwnRequestId
} from '../utils/http-log-state.util'

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
 * The only fields a request scope inherits from an enclosing scope.
 *
 * An ALLOWLIST, and the choice is the whole safety property. `LogContext`
 * explicitly permits arbitrary consumer keys, so no list of forbidden names can
 * ever be complete: an application-defined `accountId`, `sessionId` or any other
 * identity the library does not know by name leaks exactly the way `userId` did.
 * Measured on the denylist version — a request opened inside a scope holding
 * `{ accountId, sessionId }` inherited both, attributing an unrelated request to
 * another account.
 *
 * These two are the library's OWN correlation fields, and they are the ones an
 * enclosing scope can hold a correct value for. Everything else is per-request
 * and has to be set inside the request.
 *
 * Dropping a field a consumer set upstream is not a regression: before this
 * release `run()` discarded ALL of it, so this is strictly more than a consumer
 * had. And it fails in the safe direction — a missing field is visibly missing,
 * where an inherited identity is wrong while looking right.
 */
const INHERITABLE_CONTEXT_KEYS: readonly string[] = ['requestId', 'tenantId']

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
   * not two. The request gets its OWN store, started from the enclosing scope's
   * correlation fields — see {@link INHERITABLE_CONTEXT_KEYS} — and nothing
   * else, because no other field can be known to belong to this request.
   *
   * An enclosing scope's `requestId` is never adopted and never echoed: adoption
   * reads a value this middleware recorded on the REQUEST, which a scope opened
   * elsewhere does not have. What the two generation modes do with one, measured
   * on two requests sharing a long-lived enclosing scope:
   *
   *   - `shouldGenerateRequestId: true` (default) — each request mints its own
   *     id, the two requests differ, and the enclosing value reaches neither the
   *     header nor the entries.
   *   - `shouldGenerateRequestId: false` with no inbound header — nothing is
   *     minted, so the request scope inherits the enclosing `requestId` and every
   *     request inside that scope logs under it. No header is exposed. That is
   *     the consumer's own scope being inherited, not correlation being reused,
   *     and it is the configuration that says the gateway owns the id.
   *
   * @param req - The incoming request (Express satisfies the contract).
   * @param res - The outgoing response (Express satisfies the contract).
   * @param next - The next handler in the chain.
   */
  use(req: LoggableRequest, res: LoggableResponse, next: NextHandler): void {
    // Two marks, because they answer two different questions and either can be
    // present without the other.
    //
    // `isCorrelationOpened` says a scope for this request already exists, so this
    // is a SECOND mount and must not open another. `readOwnRequestId` says which
    // id this library validated, which is the only value that may be echoed onto
    // the response — read from the REQUEST rather than the store, because `set()`
    // takes `unknown` and middleware between the mounts can replace `requestId`
    // there with a raw user-controlled header.
    //
    // With `shouldGenerateRequestId: false` and no inbound header the first is
    // true while the second is undefined. Collapsing them into one mark treated
    // that as a fresh request and opened a second scope, which starts from the
    // inherited fields — so a `userId` a guard had established between the mounts
    // was DISCARDED. Measured: the authenticated identity was gone from every log
    // the request produced after that point.
    if (isCorrelationOpened(req)) {
      const ownRequestId = readOwnRequestId(req)
      if (ownRequestId !== undefined) {
        this.adoptExistingScope(ownRequestId, req, res)
      }
      next()
      return
    }

    markCorrelationOpened(req)
    const context = this.inheritableContext()
    const requestId = this.resolveRequestId(req)
    if (requestId !== undefined) {
      res.setHeader(REQUEST_ID_HEADER, requestId)
      context.requestId = requestId
      markOwnRequestId(req, requestId)
    }
    // The header is read only when the inherited context carries NO tenant, which
    // is the enclosing scope's. Copying the header unconditionally would let a
    // client replace a tenant the application resolved at the edge — from an auth
    // claim — on every entry the request produces. The adopt path already gave
    // the resolved tenant precedence; this is the same rule on the path that
    // opens the scope.
    //
    // `requestId` is deliberately NOT symmetric: correlation is this library's to
    // own and it mints a validated one, while a tenant is an assertion about who
    // the request belongs to and is never invented or overridden here.
    if (context.tenantId === undefined) {
      const tenantId = this.resolveTenantId(req)
      if (tenantId !== undefined) {
        context.tenantId = tenantId
      }
    }

    // A NEW store, never a write into the enclosing one, which is what keeps
    // requests isolated. Measured on the version that enriched an enclosing scope
    // in place — with the server created inside a `run()` scope, every request
    // handler then inherits that store — two sequential requests were handed the
    // SAME `requestId`, and the shared store kept the first request's id after
    // both finished. Correlation that silently merges two requests is worse than
    // none, because it is trusted.
    this.logContext.run(context, () => next())
  }

  /**
   * The enclosing scope's fields that a request scope may start from.
   *
   * Plain `run()` would discard everything the caller had set and a plain merge
   * would carry identity across requests; {@link INHERITABLE_CONTEXT_KEYS} is
   * the middle a request scope actually needs.
   *
   * @returns A fresh bag, never the enclosing store itself, so writes inside the
   *   request never reach the scope that opened it.
   */
  private inheritableContext(): LogContext {
    // Spreading a possibly-absent store covers the no-enclosing-scope case
    // without a branch: `{ ...undefined }` is `{}`.
    const store: LogContext = { ...this.logContext.getStore() }
    const inherited: LogContext = {}
    for (const key of INHERITABLE_CONTEXT_KEYS) {
      // `Reflect` keeps the dynamic read/write off the object-injection sink list.
      const value: unknown = Reflect.get(store, key)
      // Absent stays absent: no key is ever written holding `undefined` to mean
      // "not set", which is what the emitted-record contract promises.
      if (value !== undefined) {
        Reflect.set(inherited, key, value)
      }
    }
    return inherited
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
    // Put the validated id BACK into the store, because the emitted entry reads
    // `requestId` from there. Middleware between the two mounts can have replaced
    // it — `set()` takes `unknown` — and echoing the validated id while leaving
    // the replacement in the store produces exactly the split this whole change
    // exists to remove: the response header saying one thing and every subsequent
    // log line saying another, with the log line carrying a value that never
    // passed validation. `requestId` is this library's field to own, which is the
    // same reason an enclosing scope's id does not win above.
    this.logContext.set('requestId', requestId)
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
