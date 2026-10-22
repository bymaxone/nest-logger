/**
 * Structural mirror of `@bymax-one/nest-core`'s unexpected-error sink contract.
 *
 * Declared here, not imported: this package has no dependency on nest-core and
 * does not take one. TypeScript compares the two contracts by shape, so
 * `PinoUnexpectedErrorSink` binds to nest-core's `BYMAX_UNEXPECTED_ERROR_SINK`
 * token as long as these shapes stay compatible with nest-core's.
 */

/**
 * What nest-core hands the sink for one unexpected (non-`HttpException`) error.
 *
 * It never carries the request body, headers, query string or raw URL.
 */
export interface UnexpectedErrorReport {
  /** The original thrown value, by identity — not necessarily an `Error`. */
  readonly error: unknown
  /** HTTP method, e.g. `'GET'`. */
  readonly method: string
  /**
   * The matched route template, e.g. `'/invoices/:id'`, or `'<unmatched>'` when
   * the error was raised before routing. Never the raw URL.
   */
  readonly route: string
  /** The request's correlation id. The key is absent when none resolved. */
  readonly correlationId?: string
  /** The active OpenTelemetry trace id. The key is absent when nothing is recording. */
  readonly traceId?: string
}

/**
 * A receiver for unexpected errors, called synchronously by nest-core's
 * exception filter before the response is written.
 */
export interface IUnexpectedErrorSink {
  /**
   * Record one unexpected error. Must be cheap: it runs on the response path.
   *
   * @param report - The error and its request coordinates.
   */
  record(report: UnexpectedErrorReport): void
}
