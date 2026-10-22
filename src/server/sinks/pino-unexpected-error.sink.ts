/**
 * Pino-backed receiver for `@bymax-one/nest-core`'s unexpected-error sink.
 *
 * Layer: server/sinks — nest-core's exception filter turns an unexpected error
 * into a fixed `500` body and, until this sink existed, the only trace of it was
 * the access-log line with a synthetic `Error("GET /url → 500")`. Binding this
 * class to nest-core's `BYMAX_UNEXPECTED_ERROR_SINK` token writes one `error`
 * entry per such error, with the original error's name, message and stack:
 *
 * ```ts
 * import { BYMAX_UNEXPECTED_ERROR_SINK } from '@bymax-one/nest-core'
 * import { PinoUnexpectedErrorSink } from '@bymax-one/nest-logger'
 *
 * @Global()
 * @Module({
 *   providers: [{ provide: BYMAX_UNEXPECTED_ERROR_SINK, useClass: PinoUnexpectedErrorSink }],
 *   exports: [BYMAX_UNEXPECTED_ERROR_SINK]
 * })
 * export class UnexpectedErrorSinkModule {}
 * ```
 *
 * No nest-core import here: the contract is matched by shape (see
 * `unexpected-error-sink.interface.ts`).
 */
import { Inject, Injectable } from '@nestjs/common'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type {
  IUnexpectedErrorSink,
  UnexpectedErrorReport
} from '../interfaces/unexpected-error-sink.interface'
import { PinoLoggerService } from '../services/pino-logger.service'
import { isErrorLike, sanitizeError } from '../utils/sanitize-error.util'

/**
 * Writes each unexpected error nest-core reports as one `HTTP_UNEXPECTED_ERROR`
 * entry at `error` level.
 */
@Injectable()
export class PinoUnexpectedErrorSink implements IUnexpectedErrorSink {
  /**
   * @param logger - The structured logger the entry is written to. Injected by
   *   token explicitly: the package is bundled without `emitDecoratorMetadata`,
   *   so implicit class-type injection would not resolve.
   */
  constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {}

  /**
   * Write one `error` entry for an unexpected error. Never throws.
   *
   * The entry carries `err` (name, message, scrubbed stack, cause chain and own
   * fields, through the configured `err` serializer), `method`, `route` and,
   * when present, `correlationId`. It deliberately carries nothing else from
   * the request: the report has no body, headers or query to leak, and this
   * method adds none.
   *
   * `report.traceId` is not written. The trace mixin already stamps the active
   * span's trace id under the configured `otel.traceIdField` — the same span
   * nest-core read it from — and writing it here would override that field and
   * ignore `otel.shouldAutoInjectTraceContext: false`.
   *
   * @param report - The error and its request coordinates, from nest-core.
   * @example
   *   sink.record({ error: new TypeError('x is undefined'), method: 'GET', route: '/invoices/:id', correlationId: 'req-1' })
   *   // → { level: 'error', logKey: 'HTTP_UNEXPECTED_ERROR', msg: 'x is undefined',
   *   //     err: { type: 'TypeError', message: 'x is undefined', stack: '…' },
   *   //     method: 'GET', route: '/invoices/:id', correlationId: 'req-1' }
   */
  record(report: UnexpectedErrorReport): void {
    try {
      const metadata: Record<string, unknown> = { method: report.method, route: report.route }
      if (report.correlationId !== undefined) {
        metadata['correlationId'] = report.correlationId
      }
      // An error-like value goes through RAW so the `err` serializer keeps its
      // real type and cause chain. Anything else (a thrown string, `undefined`)
      // is normalized first: `errorStructured` reads `.message` for the line.
      const error = isErrorLike(report.error) ? report.error : sanitizeError(report.error)
      this.logger.errorStructured(
        RESERVED_LOG_KEYS.HTTP_UNEXPECTED_ERROR,
        error,
        undefined,
        metadata
      )
    } catch {
      // This runs on nest-core's response path. nest-core contains a throw from
      // the sink as well, but the guarantee belongs here too: a hostile report
      // or a failing destination must never change the response.
    }
  }
}
