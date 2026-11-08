/**
 * Reads the `http-errors` shape of a client error that is not an `HttpException`.
 *
 * Layer: server, utils. The body parser raises such an error for a body over the limit (413) or an
 * unsupported content encoding (415): an `Error` with a `status` or `statusCode` and `expose: true`,
 * which the package sets to say the message is safe to send to the client.
 */

/** The status and the message of an exposed client error. */
export interface ExposedClientError {
  /** The 4xx status the error carries. */
  readonly status: number
  /** The message the error exposes to the client. */
  readonly message: string
}

/** The lowest and highest status of a client error. */
const MIN_CLIENT_STATUS = 400
const MAX_CLIENT_STATUS = 499

/**
 * Read an exposed client error, or nothing.
 *
 * The error is the thrower's own object, so every read is guarded: a getter that throws, or a Proxy
 * that does, makes it not an exposed client error, and the caller treats it as any other failure.
 *
 * @param value - The thrown value.
 * @returns The status and message when `expose` is `true`, the status (`status`, else `statusCode`)
 *   is an integer from 400 to 499 and the message is a string; `undefined` otherwise. Never throws.
 */
export function readExposedClientError(value: unknown): ExposedClientError | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as { status?: unknown; statusCode?: unknown; expose?: unknown }
    const status = candidate.status ?? candidate.statusCode
    const message = (value as { message?: unknown }).message
    const isClientStatus =
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= MIN_CLIENT_STATUS &&
      status <= MAX_CLIENT_STATUS
    if (candidate.expose !== true || !isClientStatus || typeof message !== 'string')
      return undefined
    return { status, message }
  } catch {
    return undefined
  }
}
