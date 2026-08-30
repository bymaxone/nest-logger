/**
 * Per-request state shared by the access-log middleware and the HTTP interceptor.
 *
 * Layer: server/utils — the two components observe the same request from
 * different points of the NestJS lifecycle and must not both emit. The middleware
 * runs first and CLAIMS the lifecycle; the interceptor, running downstream,
 * checks the claim and reduces itself to recording the thrown error so the
 * middleware's `'close'` handler can serialize it.
 *
 * The claim is a Symbol-keyed property on the request object. A Symbol cannot
 * collide with a consumer's own field, is not enumerable by `Object.keys`, and so
 * never reaches a log line or a serializer. Attaching to the request rather than
 * to the middleware instance is what keeps this correct under concurrency: the
 * state belongs to one request, and providers here are singletons.
 */

/** Lower bound of the HTTP redirect (3xx) range. */
export const HTTP_REDIRECT_MIN = 300
/** Lower bound of the HTTP client-error (4xx) range. */
export const HTTP_CLIENT_ERROR_MIN = 400
/** Lower bound of the HTTP server-error (5xx) range. */
export const HTTP_SERVER_ERROR_MIN = 500

/** Fallback user-agent when the header is absent or not a string. */
const UNKNOWN_USER_AGENT = 'unknown'

/** Marks a request whose lifecycle the access-log middleware owns. */
const RECORDER_ACTIVE = Symbol('bymax-one/nest-logger:recorder')
/** Holds the error the interceptor observed, for the middleware to serialize. */
const RECORDED_ERROR = Symbol('bymax-one/nest-logger:error')
/** Holds the correlation id `RequestIdMiddleware` itself minted or accepted. */
const OWN_REQUEST_ID = Symbol('bymax-one/nest-logger:request-id')
/** Marks a request whose correlation scope `RequestIdMiddleware` itself opened. */
const CORRELATION_OPENED = Symbol('bymax-one/nest-logger:correlation')

/** A thrown value captured downstream, wrapped so `undefined` stays meaningful. */
export interface RecordedError {
  /** The value that was thrown. Already normalized to an `Error`. */
  readonly error: Error
}

/**
 * Claim the request's log lifecycle for the middleware recorder.
 *
 * @param req - The request object to mark.
 */
export function markRecorderActive(req: object): void {
  Reflect.set(req, RECORDER_ACTIVE, true)
}

/**
 * Whether the access-log middleware owns this request's log lifecycle.
 *
 * The interceptor emits its own entries when this is `false`, which is what
 * keeps a consumer that never wired the middleware from silently losing HTTP
 * logs altogether. That path is the pre-middleware behaviour, unchanged: it
 * still misses guard rejections and unmatched routes, because an interceptor
 * cannot see them.
 *
 * @param req - The request object to inspect.
 * @returns `true` when the middleware already claimed the lifecycle.
 */
export function isRecorderActive(req: object): boolean {
  return Reflect.get(req, RECORDER_ACTIVE) === true
}

/**
 * Record that `RequestIdMiddleware` opened this request's correlation scope.
 *
 * Tracked separately from {@link markOwnRequestId} because the two answer
 * different questions and one of them can be absent. With
 * `shouldGenerateRequestId: false` and no inbound header there is no id to
 * record, yet the scope was still opened — and a second mount that mistakes that
 * for a fresh request opens ANOTHER scope, which starts from the inherited
 * fields and so discards whatever a guard between the mounts had established.
 *
 * @param req - The request object to mark.
 */
export function markCorrelationOpened(req: object): void {
  Reflect.set(req, CORRELATION_OPENED, true)
}

/**
 * Whether `RequestIdMiddleware` already opened this request's correlation scope.
 *
 * @param req - The request object to inspect.
 * @returns `true` when a second mount must not open another scope.
 */
export function isCorrelationOpened(req: object): boolean {
  return Reflect.get(req, CORRELATION_OPENED) === true
}

/**
 * Remember the correlation id this library established for the request.
 *
 * @param req - The request object to attach to.
 * @param requestId - The id, already through `isAcceptableHeaderValue`.
 */
export function markOwnRequestId(req: object, requestId: string): void {
  Reflect.set(req, OWN_REQUEST_ID, requestId)
}

/**
 * Read back the correlation id this library established, if any.
 *
 * This is a security boundary rather than bookkeeping, and it is deliberately
 * the VALUE rather than a "we opened the scope" flag. `LogContextService.set()`
 * takes `unknown`, so middleware running between two mounts can replace
 * `requestId` in the store with a raw user-controlled header. A flag would still
 * read true afterwards, and the second mount would echo that replacement onto
 * the response header — where an oversized value rides on every entry for the
 * request's lifetime and a CR/LF value makes `res.setHeader` throw
 * `ERR_INVALID_CHAR` before the request reaches the application.
 *
 * Reading the id from the REQUEST means what is echoed is what this library
 * validated, whatever the store holds by then.
 *
 * @param req - The request object to inspect.
 * @returns The validated id, or `undefined` when this library set none.
 */
export function readOwnRequestId(req: object): string | undefined {
  // No `typeof` guard: the absent case already reads as `undefined`, and only
  // a validated string is ever written here — a guard would add an arm no input
  // can distinguish.
  return Reflect.get(req, OWN_REQUEST_ID) as string | undefined
}

/**
 * Record the error observed downstream so the terminal entry can carry it.
 *
 * The interceptor sees the thrown value; the middleware's `'close'` handler sees
 * only a status code. Without this hand-off the terminal line for a 5xx would
 * lose the stack, which is the most useful part of it.
 *
 * @param req - The request object to attach to.
 * @param error - The value that was thrown (already an `Error`).
 */
export function recordError(req: object, error: Error): void {
  Reflect.set(req, RECORDED_ERROR, { error } satisfies RecordedError)
}

/**
 * Read back the error recorded for this request, if any.
 *
 * @param req - The request object to inspect.
 * @returns The recorded error wrapper, or `undefined` when nothing threw.
 */
export function readRecordedError(req: object): RecordedError | undefined {
  // No `=== undefined` guard: the absent case ALREADY reads as `undefined`, so
  // the ternary that used to be here returned the same value down both arms —
  // an equivalent mutant by construction rather than a check.
  return Reflect.get(req, RECORDED_ERROR) as RecordedError | undefined
}

/**
 * Normalize a thrown value to an `Error`.
 *
 * A `throw` can carry anything. The error serializer keys off an `Error`
 * instance, so a string or object thrown by a dependency would otherwise reach
 * the sink with no message and no stack.
 *
 * @param thrown - The value that was thrown (anything).
 * @returns `thrown` itself when it is an `Error`, or one wrapping its text.
 */
export function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

/**
 * The acting user id, when upstream auth attached a principal.
 *
 * `sub` first, then `id`: a JWT principal (every `@bymax-one/nest-auth` token)
 * names it `sub`, while an ORM-style principal names it `id`.
 *
 * @param req - The request carrying an optional `user`.
 * @returns The user id, or `undefined` when there is no principal.
 */
export function readUserId(req: {
  readonly user?:
    { readonly id?: string | undefined; readonly sub?: string | undefined } | undefined
}): string | undefined {
  return req.user?.sub ?? req.user?.id
}

/**
 * The request's user agent, or {@link UNKNOWN_USER_AGENT}.
 *
 * The header is attacker-controlled and unbounded, so the value passes through
 * the logger's per-field size bound like any other field rather than being
 * trusted for its length.
 *
 * @param req - The request carrying inbound headers.
 * @returns The user-agent string, or `'unknown'`.
 */
export function readUserAgent(req: {
  readonly headers: Record<string, string | string[] | undefined>
}): string {
  const raw = req.headers['user-agent']
  return typeof raw === 'string' ? raw : UNKNOWN_USER_AGENT
}
