/**
 * Public API of `@bymax-one/nest-logger` (server entry).
 *
 * Exposes the dynamic module, the logger + context services, the default
 * destination, the public option/contract types, the DI tokens, and the
 * convenience re-exports from the shared subpath. Internal utilities
 * (`otel-detector`, `trace-context.mixin`, `pino-factory`, the module builder)
 * are intentionally NOT exported — they are implementation details.
 */

// Module
export { BymaxLoggerModule } from './logger.module'

// Services
export { PinoLoggerService } from './services/pino-logger.service'
export { LogContextService } from './services/log-context.service'

// Destinations
export { DefaultStdoutDestination } from './destinations/default-stdout.destination'
export { PrettyDevDestination } from './destinations/pretty-dev.destination'

// HTTP integration (interceptor, filter, middleware)
export { HttpExceptionFilter } from './filters/http-exception.filter'
export { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
export { applyRequestIdMiddleware } from './middlewares/apply-request-id-middleware'
export { RequestIdMiddleware } from './middlewares/request-id.middleware'

// Decorators
export { InjectLogger } from './decorators/inject-logger.decorator'
export { LogContext, LOG_CONTEXT_METADATA_KEY } from './decorators/log-context.decorator'
export { LogPerformance } from './decorators/log-performance.decorator'

// Interfaces and contracts
// The per-request context bag is exported as `LogContextBag` (the bare
// `LogContext` name belongs to the class-level decorator above) so consumers can
// type `LogContextService.run()` / `.set()` arguments. `ResolvedBymaxLoggerModuleOptions`
// is exported because it surfaces in the public `.d.ts` of the interceptor/middleware
// constructors. The `Loggable*` HTTP contracts are exported for the same reason:
// they type `RequestIdMiddleware.use()`, so a consumer calling it directly needs
// to be able to name them.
export type {
  ILogDestination,
  IncomingHeaders,
  LoggableRequest,
  LoggableResponse,
  NextHandler,
  BymaxLoggerModuleOptions,
  BymaxLoggerModuleAsyncOptions,
  BymaxLoggerModuleOptionsFactory,
  ResolvedBymaxLoggerModuleOptions,
  HttpOptions,
  OtelOptions,
  LogContext as LogContextBag
} from './interfaces'

// DI tokens
export {
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOG_CONTEXT_TOKEN
} from './constants/injection-tokens.constants'

// Constants
export { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'

// Shared re-exports (convenience)
export type { LogLevel, LogEntry, ServiceMetadata } from '../shared'
export { LOG_KEYS_CONVENTION_REGEX, RESERVED_LOG_KEYS } from '../shared'
