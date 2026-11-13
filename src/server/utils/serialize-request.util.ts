/**
 * The default serializer of a request object logged under the `req` key.
 *
 * Layer: server/utils — a pure helper registered by the Pino factory. A Node `IncomingMessage` (and
 * the Express or Fastify request built on it) is a graph of sockets, parsers and servers, and it
 * carries the credentials of the call twice: in `headers`, and in `rawHeaders`, a flat array of
 * alternating names and values in which a value sits beside its name instead of under a key. Logging
 * one whole wrote every header value of the request, whatever its name, along with the internals of
 * the connection. The serializer keeps the facts a request line is for and leaves the rest out.
 */
import { scrubSecretSegments, stripQueryString } from './normalize-url.util'

/** The fields of a request the serializer reads. */
interface RequestLike {
  readonly method?: unknown
  readonly url?: unknown
  readonly originalUrl?: unknown
  readonly headers?: unknown
  readonly rawHeaders?: unknown
  readonly socket?: unknown
}

/** What is written for a request: its identity, its headers and the peer, and nothing else. */
export interface SerializedRequest {
  readonly method: unknown
  readonly url: unknown
  readonly headers: Record<string, unknown>
  readonly remoteAddress: unknown
}

/** A non-null object, the only shape a request can have. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Whether `value` is a request in the Node sense: a message with raw headers, or one with a method
 * and a connection. A plain record a host put under `req` is not, and is written as it is.
 */
function isRequest(value: unknown): value is RequestLike {
  if (!isObject(value)) return false
  const { rawHeaders, method, socket } = value as RequestLike
  return Array.isArray(rawHeaders) || (typeof method === 'string' && isObject(socket))
}

/** The own enumerable headers as a plain record; a non-object `headers` is an empty one. */
function copyHeaders(headers: unknown): Record<string, unknown> {
  return isObject(headers) ? { ...(headers as Record<string, unknown>) } : {}
}

/**
 * Serialize a request, or return any other value unchanged.
 *
 * The URL is written without its query string and with its credential path segments replaced, as the
 * access log writes it. The header values are left for the name redaction, which censors them by
 * name after the serializer runs. `rawHeaders`, the socket and the rest of the object are not
 * written. A request whose fields cannot be read is written as a marker, never thrown.
 *
 * @param input - The value logged under `req`.
 * @param secretSegments - The host's own credential patterns for a path segment (`http.secretPathSegments`).
 * @returns The serialized request, or `input` when it is not a request.
 * @example
 *   serializeRequestValue(req)
 *   // → { method: 'GET', url: '/auth/reset/:redacted', headers: { ... }, remoteAddress: '::1' }
 */
export function serializeRequestValue(
  input: unknown,
  secretSegments: readonly RegExp[] = []
): unknown {
  try {
    if (!isRequest(input)) return input
    const url = input.originalUrl ?? input.url
    const socket = input.socket as { remoteAddress?: unknown } | undefined
    return {
      method: input.method,
      url:
        typeof url === 'string' ? scrubSecretSegments(stripQueryString(url), secretSegments) : url,
      headers: copyHeaders(input.headers),
      remoteAddress: socket?.remoteAddress
    } satisfies SerializedRequest
  } catch {
    return { _unserializable: 'request' }
  }
}

/**
 * The record with its `req` field serialized when that field is a request.
 *
 * @param record - The merged record about to be redacted.
 * @param secretSegments - The host's own credential patterns for a path segment.
 * @returns `record` itself when `req` is absent or not a request, otherwise a shallow copy that holds
 *   the serialized request.
 */
export function withSerializedRequest(
  record: Record<string, unknown>,
  secretSegments: readonly RegExp[] = []
): Record<string, unknown> {
  const request = record['req']
  const serialized = serializeRequestValue(request, secretSegments)
  return serialized === request ? record : { ...record, req: serialized }
}
