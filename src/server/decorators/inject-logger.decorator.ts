/**
 * `@InjectLogger` parameter decorator.
 *
 * Layer: server/decorators — convenience over `@Inject(PinoLoggerService)` for
 * constructor parameters.
 *
 *   - `@InjectLogger()` (no context) injects the shared root `PinoLoggerService`.
 *   - `@InjectLogger('UsersController')` injects a CHILD logger pre-bound to
 *     `{ context: 'UsersController' }`, so every entry it emits carries that
 *     context automatically — no `setContext()` call, no shared-singleton
 *     mutation. The child-logger provider is auto-registered by
 *     `BymaxLoggerModule` (see {@link createContextLoggerProvider}).
 *
 * The context label is also recorded as reflect-metadata under the param slot,
 * preserved for tooling/introspection.
 *
 * See `docs/development_plan.md` §4.4 / §5.4a for the design rationale.
 */
import { Inject } from '@nestjs/common'

import { getContextLoggerToken } from './inject-logger.provider'
import { PinoLoggerService } from '../services/pino-logger.service'

/** Reflect-metadata key under which a per-injection context label is stored. */
export const INJECT_LOGGER_CONTEXT_METADATA_KEY = 'bymax_logger:context'

/**
 * Inject a logger into a constructor parameter.
 *
 * With a `context` the injected logger is a child bound to that context (every
 * log carries it); without one, the shared `PinoLoggerService` is injected.
 *
 * @param context - Optional context label (typically the host class name).
 * @returns A parameter decorator wiring the injection (and recording the label).
 * @example
 *   @Injectable()
 *   export class UsersService {
 *     constructor(@InjectLogger('UsersService') private readonly logger: PinoLoggerService) {}
 *   }
 *   // every `this.logger.*` entry now carries context: 'UsersService'
 */
export function InjectLogger(context?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (context === undefined) {
      Inject(PinoLoggerService)(target, propertyKey, parameterIndex)
      return
    }
    // Bind to the per-context child-logger token (memoized so the module's
    // provider resolves to the same token).
    Inject(getContextLoggerToken(context))(target, propertyKey, parameterIndex)
    Reflect.defineMetadata(
      INJECT_LOGGER_CONTEXT_METADATA_KEY,
      context,
      target,
      `${String(propertyKey)}:${parameterIndex}`
    )
  }
}
