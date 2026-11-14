/**
 * Pino-backed receiver for `@bymax-one/nest-core`'s unexpected-error sink.
 *
 * Layer: server/sinks — nest-core's exception filter answers an unexpected error
 * with a fixed `500` body. The access-log line for that response carries the
 * cause only when this package's HTTP interceptor saw the error, which it does
 * not for an error raised before it (a guard, a middleware) or with HTTP logging
 * off. Binding this class to nest-core's `BYMAX_UNEXPECTED_ERROR_SINK` token
 * writes one `error` entry per such error regardless, with the original error's
 * name, message and stack:
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
import { reportDestinationFailure } from '../utils/report-destination-failure.util'
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
      if (isCount(report.repeated)) {
        metadata['repeated'] = report.repeated
      }
      Object.assign(metadata, exceptionFields(report.error))
      this.logger.errorStructured(
        RESERVED_LOG_KEYS.HTTP_UNEXPECTED_ERROR,
        toLoggableError(report.error),
        undefined,
        metadata
      )
    } catch (cause) {
      // This runs on nest-core's response path. nest-core contains a throw from
      // the sink as well, but the guarantee belongs here too: a hostile report
      // or a failing destination must never change the response. The report is
      // the only log record of an unhandled exception, so its loss is announced on
      // stderr, outside the sink set that may be what failed, and never swallowed.
      reportDestinationFailure(
        RESERVED_LOG_KEYS.HTTP_UNEXPECTED_ERROR_DROPPED,
        'PinoUnexpectedErrorSink',
        cause,
        'An unexpected-error report could not be logged and was dropped.'
      )
    }
  }
}

/**
 * The thrown value in the form `errorStructured` takes.
 *
 * An error-like value goes through RAW so the `err` serializer keeps its real
 * type and cause chain. Anything else (a thrown string, `undefined`) is
 * normalized first, because `errorStructured` reads `.message` for the line.
 *
 * @param value - The thrown value, as nest-core reported it.
 * @returns The value itself when it reads as an error, else its sanitized form.
 */
function toLoggableError(value: unknown): Error {
  // Neither call throws: `isErrorLike` answers for a value whose `name` or `message` cannot
  // be read, and `sanitizeError` degrades such a value to its `SanitizeFailed` node.
  return isErrorLike(value) ? value : sanitizeError(value)
}

/** Longest `code` written: a code is a short identifier, and the field is not a place for a message. */
const MAX_CODE_LENGTH = 128

/** A positive whole number a counter can hold exactly. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Whether a value is a non-null object, the shape a response carrier and `details` take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The `code` and `details` a typed exception carries in its response, as the metadata fields
 * `errorCode` and `errorDetails`.
 *
 * nest-core answers with `{ code, message, details }` flat on the response, or nested under `error`;
 * both are read the way nest-core reads them. An error with no `getResponse`, one whose response is
 * text, or one that throws while being read has no such fields, and the report is still written
 * without them: reading these is a courtesy to the operator and never a reason to lose the entry.
 *
 * @param error - The value nest-core reported, by identity.
 * @returns The fields that could be read, possibly none.
 */
function exceptionFields(error: unknown): Record<string, unknown> {
  try {
    // Stryker disable next-line ConditionalExpression: `typeof error['getResponse'] !== 'function'` replaced by `false` is equivalent. The call below then throws for a value that is not a function and the catch returns the same empty result; the check only spares an ordinary error, the common case, a thrown exception.
    if (!isRecord(error) || typeof error['getResponse'] !== 'function') return {}
    const response: unknown = (error['getResponse'] as () => unknown)()
    if (!isRecord(response)) return {}
    const nested = response['error']
    const carrier = isRecord(nested) && typeof nested['code'] === 'string' ? nested : response
    const fields: Record<string, unknown> = {}
    const code = carrier['code']
    if (typeof code === 'string') {
      fields['errorCode'] = code.slice(0, MAX_CODE_LENGTH)
    }
    const details = carrier['details']
    if (isRecord(details)) {
      fields['errorDetails'] = details
    }
    return fields
  } catch {
    return {}
  }
}
