/**
 * Error layer between the body parser and Nest's exception handler: it keeps the type of a
 * parser error whose message quotes the body, for the exception filter.
 *
 * Layer: server, middlewares.
 */
import { readExposedClientError } from '../utils/exposed-client-error.util'
import { recordParserError } from '../utils/http-log-state.util'

/**
 * Express error middleware: record a body-parser error whose message may quote the body, then pass
 * the error on untouched.
 *
 * @param error - The error the layers before this one passed on.
 * @param req - The request.
 * @param _res - The response, unused.
 * @param next - Called with the same error, always.
 */
export function recordParserErrorMiddleware(
  error: unknown,
  req: object,
  _res: unknown,
  next: (error?: unknown) => void
): void {
  try {
    const exposed = readExposedClientError(error)
    if (exposed?.bodyParserType !== undefined) recordParserError(req, exposed)
  } catch {
    // Recording is best effort: a request that cannot hold it still gets its error passed on.
  }
  next(error)
}
