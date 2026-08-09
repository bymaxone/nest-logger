/**
 * Minimal HTTP request/response contracts the logging layer reads.
 *
 * Layer: server/interfaces — exported structural contracts shared by the HTTP
 * logging interceptor, the exception filter and the request-id middleware. They
 * are part of the public API: they appear in those components' published
 * signatures, so a consumer calling `RequestIdMiddleware.use()` directly needs
 * to be able to name them. Declared structurally, listing only the members
 * those three actually touch, so the published declarations depend on no HTTP
 * framework's types. Naming Express's
 * `Request`/`Response` here would make the emitted `.d.ts` import from
 * `express`, forcing every consumer that compiles with `skipLibCheck: false` to
 * install `@types/express` whether or not they use those signatures.
 *
 * The shapes mirror what the Express adapter provides — `status().json()` and
 * `setHeader()` are Express/Node response methods — so this is not an
 * adapter-agnostic abstraction; a Fastify adapter remains unsupported. An
 * Express request and response satisfy these contracts structurally, with no
 * cast at the call site.
 */

/** Raw inbound headers, as the HTTP layer delivers them. */
export type IncomingHeaders = Record<string, string | string[] | undefined>

/**
 * The inbound request members the logging layer reads.
 *
 * `user` is populated by upstream auth in the consumer app (a guard or
 * middleware). The acting-user id is read as `sub` first, then `id`: a JWT principal
 * (every `@bymax-one/nest-auth` token) names it `sub`, while an ORM-style principal
 * names it `id`. The JWT subject wins when both are present, since it is the
 * authenticated identity. Reading only `id` — as this once did — silently dropped
 * the user field for every JWT-authenticated request.
 */
export interface LoggableRequest {
  /** Inbound headers — read for correlation ids and the user agent. */
  readonly headers: IncomingHeaders
  /** HTTP verb, logged as-is. */
  readonly method: string
  /** Request target, normalized and query-stripped before it reaches a log. */
  readonly url: string
  /** Client address when the adapter resolves one. */
  readonly ip?: string | undefined
  /**
   * Authenticated principal, when upstream auth attached one. `id` is the
   * ORM-style identifier; `sub` is the JWT subject claim. The logging layer reads
   * whichever is present.
   */
  readonly user?:
    { readonly id?: string | undefined; readonly sub?: string | undefined } | undefined
}

/**
 * The outbound response members the logging layer writes or reads: the status
 * for the terminal log entry, `setHeader` to echo the correlation id, and the
 * chainable `status().json()` used by the exception filter to emit a body.
 */
export interface LoggableResponse {
  /** Status code, read when logging the completed request. */
  readonly statusCode: number
  /** Sets a response header (used for the correlation id). */
  setHeader(name: string, value: string): void
  /** Selects the status code and returns the chainable body writer. */
  status(code: number): { json(body: unknown): unknown }
}

/** Continuation passed to a middleware; invoked with no arguments here. */
export type NextHandler = () => void
