/**
 * `@LogContext` class decorator.
 *
 * Layer: server/decorators — attaches a context label to a class via NestJS
 * metadata. A future `LoggerContextInterceptor` (Phase 4) reads this metadata to
 * auto-apply `setContext()` on the class's injected logger. In Phase 3 it only
 * records the label; the interim workaround is calling `logger.setContext()`
 * manually in the constructor.
 *
 * See `docs/development_plan.md` §4.4 for the design rationale.
 */
import { SetMetadata } from '@nestjs/common'
import type { CustomDecorator } from '@nestjs/common'

/** Reflect-metadata key under which the class context label is stored. */
export const LOG_CONTEXT_METADATA_KEY = 'bymax_logger:log_context'

/**
 * Set the log-context label for a class. All loggers injected within the class
 * are intended to adopt this label (auto-application lands in Phase 4).
 *
 * @param name - The context label (typically the class name).
 * @returns A NestJS metadata decorator carrying the label.
 * @example
 *   @LogContext('PaymentsService')
 *   @Injectable()
 *   export class PaymentsService {}
 */
export const LogContext = (name: string): CustomDecorator<string> =>
  SetMetadata(LOG_CONTEXT_METADATA_KEY, name)
