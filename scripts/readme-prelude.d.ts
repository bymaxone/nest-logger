/**
 * @fileoverview The names a README snippet uses without declaring them, typed against the
 * published package. `check-published-surface.mjs` copies this file into the throwaway
 * consumer it compiles the snippets in, so a call made through one of these names is
 * checked against the real types instead of resolving to `any`.
 * @layer scripts
 *
 * Only names the surrounding prose introduces belong here. A wrong option, method or
 * field on a type the package exports is a real error and must stay one, so nothing
 * here widens a package type.
 */
import type { ILogDestination, LogContextService, PinoLoggerService } from '@bymax-one/nest-logger'

declare global {
  /** What `this` holds in a snippet that shows logger calls without a class around them. */
  interface SnippetContext {
    logger: PinoLoggerService
    logContext: LogContextService
  }

  /** The service a snippet calls once it has been injected. */
  const logger: PinoLoggerService
  /** Values a snippet takes from the request or the surrounding code. */
  const userId: string
  const familyId: string

  /** `@nestjs/config`, a peer the compile fixture does not install. */
  class ConfigService {
    get<T = string>(key: string): T | undefined
    getOrThrow<T = string>(key: string): T
  }

  /** Defined by the "Custom Destinations" snippet, which is a separate module here. */
  class LokiDestination implements ILogDestination {
    constructor(opts: {
      url: string
      username: string
      password: string
      labels: Record<string, string>
    })
    readonly name: string
    write: ILogDestination['write']
  }
}
