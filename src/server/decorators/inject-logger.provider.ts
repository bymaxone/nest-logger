/**
 * Child-logger provider factory for `@InjectLogger(context)`.
 *
 * Layer: server/decorators — turns the `context` argument of
 * `@InjectLogger('UsersController')` into a DI provider that resolves to a Pino
 * CHILD logger pre-bound to `{ context }`. Every entry the injected logger emits
 * therefore carries `context: 'UsersController'` automatically, WITHOUT mutating
 * the shared `PinoLoggerService` singleton (which would race across feature
 * modules) and WITHOUT request scope (which would cascade scope onto the whole
 * dependency tree).
 *
 * Auto-discovery: the decorator registers each `context` here at class-decoration
 * time; `BymaxLoggerModule` reads the registry at `forRoot` / `forRootAsync` and
 * provides one child-logger provider per context. This works for the idiomatic
 * setup (inline `forRoot` in the root module, which ES-evaluates feature classes
 * — and their decorators — before the root `@Module` runs). Contexts introduced
 * by lazily-loaded modules after registration are out of scope for v0.1.
 */
import type { Provider } from '@nestjs/common'

import { PinoLoggerService } from '../services/pino-logger.service'

/**
 * Memoized `context -> token` registry. Doubles as the discovery set: its keys
 * are every context seen across `@InjectLogger(context)` usages. A `Map`
 * guarantees the SAME context name always resolves to the SAME token (so the
 * decorator's `@Inject(token)` and the module's provider agree).
 */
const contextTokens = new Map<string, symbol>()

/**
 * Get (or lazily create) the deterministic DI token for a logger context.
 *
 * @param context - The context label (typically the host class name).
 * @returns A stable, memoized `symbol` token unique to this context.
 */
export function getContextLoggerToken(context: string): symbol {
  const existing = contextTokens.get(context)
  if (existing !== undefined) {
    return existing
  }
  const token = Symbol(`INJECTED_LOGGER_${context}`)
  contextTokens.set(context, token)
  return token
}

/**
 * Build the DI provider that resolves a context's token to a child logger.
 *
 * @param context - The context label to bind onto the child logger.
 * @returns A factory provider yielding `rootLogger.child({ context })`.
 */
export function createContextLoggerProvider(context: string): Provider {
  return {
    provide: getContextLoggerToken(context),
    useFactory: (rootLogger: PinoLoggerService): PinoLoggerService => rootLogger.child({ context }),
    inject: [PinoLoggerService]
  }
}

/**
 * Every child-logger provider for the contexts discovered so far — one per
 * unique `@InjectLogger(context)` usage. Consumed by `BymaxLoggerModule` on both
 * the sync and async registration paths.
 *
 * @returns The provider list (empty when no contextual `@InjectLogger` is used).
 */
export function collectContextLoggerProviders(): Provider[] {
  return Array.from(contextTokens.keys(), (context) => createContextLoggerProvider(context))
}

/**
 * The tokens of every discovered context provider — added to the module's
 * `exports` so consumer modules can inject them (the module is global).
 *
 * @returns The token list (empty when no contextual `@InjectLogger` is used).
 */
export function collectContextLoggerTokens(): symbol[] {
  return Array.from(contextTokens.values())
}
