/**
 * `@InjectLogger` parameter decorator.
 *
 * Layer: server/decorators — convenience over `@Inject(PinoLoggerService)` for
 * constructor parameters. When a context label is supplied it is recorded as
 * reflect-metadata for a future `LoggerContextInterceptor` (Phase 4) to read and
 * auto-apply via `setContext()`. In Phase 3 the decorator only performs the
 * injection and records the label; the interim workaround for context is calling
 * `logger.setContext('MyService')` in the constructor.
 *
 * See `docs/development_plan.md` §4.4 for the design rationale.
 */
import { Inject } from '@nestjs/common'

import { PinoLoggerService } from '../services/pino-logger.service'

/** Reflect-metadata key under which a per-injection context label is stored. */
export const INJECT_LOGGER_CONTEXT_METADATA_KEY = 'bymax_logger:context'

/**
 * Inject `PinoLoggerService` into a constructor parameter, optionally recording
 * a context label for later auto-application.
 *
 * @param context - Optional context label (typically the host class name).
 * @returns A parameter decorator that wires the injection (and the label).
 * @example
 *   @Injectable()
 *   export class UsersService {
 *     constructor(@InjectLogger('UsersService') private readonly logger: PinoLoggerService) {}
 *   }
 */
export function InjectLogger(context?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    Inject(PinoLoggerService)(target, propertyKey, parameterIndex)
    if (context !== undefined) {
      Reflect.defineMetadata(
        INJECT_LOGGER_CONTEXT_METADATA_KEY,
        context,
        target,
        `${String(propertyKey)}:${parameterIndex}`
      )
    }
  }
}
