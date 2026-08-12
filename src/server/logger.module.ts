/**
 * `BymaxLoggerModule` — the NestJS dynamic module wiring the Pino-backed logger.
 *
 * Layer: server — extends the configurable-module base to add the runtime
 * providers (resolved options, Pino instance, destinations, services) and emit
 * the bootstrap log. Both the synchronous `forRoot` and asynchronous
 * `forRootAsync` registration paths live here and share a common provider set.
 */
import { Module } from '@nestjs/common'
import type { DynamicModule, INestApplication, NestInterceptor, Provider } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'

import { applyDefaults } from './config/default-options'
import { validateOptions } from './config/validate-options'
import {
  LOG_CONTEXT_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN
} from './constants/injection-tokens.constants'
import {
  collectContextLoggerProviders,
  collectContextLoggerTokens
} from './decorators/inject-logger.provider'
import { DefaultStdoutDestination } from './destinations/default-stdout.destination'
import { HttpExceptionFilter } from './filters/http-exception.filter'
import { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
import { PassThroughInterceptor } from './interceptors/passthrough.interceptor'
import type { ILogDestination } from './interfaces/log-destination.interface'
import type {
  BymaxLoggerModuleOptions,
  ResolvedBymaxLoggerModuleOptions
} from './interfaces/logger-module-options.interface'
import { BymaxLoggerModuleBase, BUILDER_OPTIONS_TOKEN } from './logger.module.builder'
import type { ASYNC_OPTIONS_TYPE, OPTIONS_TYPE } from './logger.module.builder'
import { buildPinoInstance } from './pino-factory'
import { DestinationRegistry } from './services/destination-registry.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

/** Internal token whose eager instantiation emits the one-shot bootstrap log. */
const LOGGER_BOOTSTRAP_TOKEN: unique symbol = Symbol('BYMAX_LOGGER_BOOTSTRAP')

/**
 * Pick the active destinations: the consumer's list, or the default stdout sink
 * when none were supplied.
 *
 * @param options - Resolved module options.
 * @returns A non-empty destinations list.
 */
function resolveDestinations(
  options: ResolvedBymaxLoggerModuleOptions
): readonly ILogDestination[] {
  return options.destinations.length > 0 ? options.destinations : [new DefaultStdoutDestination()]
}

/**
 * Provider whose factory emits the one-shot bootstrap entries, when NestJS
 * eagerly instantiates the module's providers.
 *
 * Emits `LOGGER_BOOTSTRAP_OK` always, and `LOGGER_BOOTSTRAP_WARNING` when the
 * consumer turned the default PII protection off. That warning is the audit
 * trail the security documentation has always promised — a deployment that
 * disabled redaction must say so in its own logs, where a review can find it,
 * rather than being indistinguishable from a protected one.
 *
 * @returns The bootstrap provider.
 */
function bootstrapProvider(): Provider {
  return {
    provide: LOGGER_BOOTSTRAP_TOKEN,
    useFactory: (logger: PinoLoggerService, options: ResolvedBymaxLoggerModuleOptions): boolean => {
      logger.info(RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK, 'BymaxLoggerModule initialized')
      if (options.shouldDisableDefaultRedact) {
        logger.warnStructured(
          RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_WARNING,
          'Default PII redaction is DISABLED — sensitive fields will be logged verbatim ' +
            'unless every one of them is listed in options.redactPaths',
          undefined,
          { shouldDisableDefaultRedact: true, redactPathCount: options.redactPaths.length }
        )
      }
      // Stryker disable next-line BooleanLiteral: equivalent — this value is stored as the `LOGGER_BOOTSTRAP_TOKEN` injectable, which nothing in the module or in consumer code reads. Flipping it to `false` is observable only by inspecting the DI container directly, never through any behaviour the library exposes.
      return true
    },
    inject: [PinoLoggerService, LOGGER_OPTIONS_TOKEN]
  }
}

/**
 * Providers shared by both registration paths. Every factory reads the resolved
 * options from `LOGGER_OPTIONS_TOKEN` (supplied per-path), so the Pino instance,
 * destinations, and bootstrap log are all produced when NestJS instantiates the
 * module. `LogContextService` is a single DI-managed singleton shared with the
 * Pino factory — no manual instantiation, so lifecycle hooks stay consistent
 * across sync and async paths.
 *
 * @returns The path-agnostic provider list.
 */
function buildCommonProviders(): Provider[] {
  return [
    LogContextService,
    { provide: LOG_CONTEXT_TOKEN, useExisting: LogContextService },
    {
      provide: LOGGER_PINO_INSTANCE_TOKEN,
      useFactory: (
        options: ResolvedBymaxLoggerModuleOptions,
        logContext: LogContextService,
        destinations: readonly ILogDestination[]
      ) => buildPinoInstance(options, logContext, destinations),
      inject: [LOGGER_OPTIONS_TOKEN, LogContextService, LOGGER_DESTINATIONS_TOKEN]
    },
    {
      provide: LOGGER_DESTINATIONS_TOKEN,
      useFactory: (options: ResolvedBymaxLoggerModuleOptions): readonly ILogDestination[] =>
        resolveDestinations(options),
      inject: [LOGGER_OPTIONS_TOKEN]
    },
    PinoLoggerService,
    // Internal lifecycle owner for destinations (onInit / onShutdown). Not
    // exported — consumers never inject it directly.
    DestinationRegistry,
    // One child-logger provider per context discovered from @InjectLogger(context).
    ...collectContextLoggerProviders(),
    bootstrapProvider()
  ]
}

/**
 * Global HTTP interceptor provider for the ASYNC registration path.
 *
 * Async-resolved options are unknown when the providers array is built, so the
 * interceptor slot is always registered and gated at the factory: the real
 * {@link HttpLoggingInterceptor} when `http.isEnabled`, otherwise a transparent
 * {@link PassThroughInterceptor} (which only forwards — safe to leave registered
 * when HTTP logging is off). This gives `forRootAsync` access-log parity with the
 * sync `forRoot` without auto-installing the catch-all exception filter (see the
 * `forRootAsync` doc for why the filter stays explicit).
 *
 * @internal Exported only for unit testing; NOT re-exported by the package barrel.
 * @returns The `APP_INTERCEPTOR` provider for the async path.
 */
export function asyncHttpInterceptorProvider(): Provider {
  return {
    provide: APP_INTERCEPTOR,
    useFactory: (
      options: ResolvedBymaxLoggerModuleOptions,
      logger: PinoLoggerService
    ): NestInterceptor =>
      options.http.isEnabled
        ? new HttpLoggingInterceptor(logger, options)
        : new PassThroughInterceptor(),
    inject: [LOGGER_OPTIONS_TOKEN, PinoLoggerService]
  }
}

/**
 * Merge library providers/exports into the builder-produced base definition.
 *
 * @internal Exported only for unit testing; NOT re-exported by the package
 *   barrel, so it is not part of the public API.
 * @param base - The `DynamicModule` returned by the builder (`super.forRoot` /
 *   `super.forRootAsync`).
 * @param providers - Library providers to append.
 * @returns The augmented `DynamicModule`.
 */
export function augmentLoggerModule(base: DynamicModule, providers: Provider[]): DynamicModule {
  return {
    ...base,
    module: BymaxLoggerModule,
    providers: [...(base.providers ?? []), ...providers],
    exports: [
      ...(base.exports ?? []),
      LOGGER_OPTIONS_TOKEN,
      LOGGER_PINO_INSTANCE_TOKEN,
      LOGGER_DESTINATIONS_TOKEN,
      LOG_CONTEXT_TOKEN,
      LogContextService,
      PinoLoggerService,
      // Export the per-context child-logger tokens so consumer modules can inject
      // them (the module is global, so only exported providers are visible).
      ...collectContextLoggerTokens()
    ]
  }
}

@Module({})
export class BymaxLoggerModule extends BymaxLoggerModuleBase {
  /**
   * Synchronous registration.
   *
   * @param options - Logger options (plus the `isGlobal` extra).
   * @returns The configured `DynamicModule`.
   * @throws Error When the options fail validation.
   * @example
   *   BymaxLoggerModule.forRoot({ service: { name: 'api', version: '1.0.0' } })
   */
  static override forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    validateOptions(options)
    const resolved = applyDefaults(options)
    const providers: Provider[] = [
      { provide: LOGGER_OPTIONS_TOKEN, useValue: resolved },
      ...buildCommonProviders()
    ]
    // The HTTP interceptor/filter are opt-in: registered globally only when the
    // consumer enables `http`. The filter is further gated on
    // `shouldCaptureExceptions` so consumers can keep the access log without the
    // catch-all exception handler.
    if (resolved.http.isEnabled) {
      providers.push({ provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor })
      if (resolved.http.shouldCaptureExceptions) {
        providers.push({ provide: APP_FILTER, useClass: HttpExceptionFilter })
      }
    }
    return augmentLoggerModule(super.forRoot(options), providers)
  }

  /**
   * Asynchronous registration. Options are resolved lazily via the consumer's
   * factory (`useFactory` + `inject` + `imports`, `useClass`, or `useExisting`);
   * the Pino instance and the bootstrap log are produced only after they
   * resolve, never at module-decoration time.
   *
   * Note: the destination-registry `onModuleInit` lifecycle hook is managed by
   * `DestinationRegistry` itself, not by this factory. The destinations array is
   * registered under `LOGGER_DESTINATIONS_TOKEN`; no built-in destination defines
   * an `onInit` hook, so nothing is lost.
   *
   * HTTP access logging IS supported on this path: the global interceptor slot
   * is always registered and gated at runtime against the resolved
   * `http.isEnabled` (see {@link asyncHttpInterceptorProvider}). The catch-all
   * exception FILTER is intentionally NOT auto-wired here — registering a global
   * `@Catch()` filter from async config would either interfere with a consumer's
   * own filters (when disabled) or require unsafe re-throwing. Async consumers who
   * want it register `HttpExceptionFilter` themselves:
   * `{ provide: APP_FILTER, useClass: HttpExceptionFilter }`.
   *
   * @param options - Async options (factory + inject + imports, or class).
   * @returns The configured `DynamicModule`.
   */
  static override forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    const providers: Provider[] = [
      {
        provide: LOGGER_OPTIONS_TOKEN,
        useFactory: (raw: BymaxLoggerModuleOptions): ResolvedBymaxLoggerModuleOptions => {
          validateOptions(raw)
          return applyDefaults(raw)
        },
        inject: [BUILDER_OPTIONS_TOKEN]
      },
      ...buildCommonProviders(),
      // Access-log interceptor with parity to the sync path: always registered,
      // gated at runtime against the async-resolved `http.isEnabled`.
      asyncHttpInterceptorProvider()
    ]
    return augmentLoggerModule(super.forRootAsync(options), providers)
  }

  /**
   * Replace NestJS's internal logger with this library's `PinoLoggerService` and
   * flush any logs buffered since `NestFactory.create(..., { bufferLogs: true })`.
   *
   * Call once in `main.ts` AFTER creating the app and BEFORE `app.listen(...)`.
   * The module cannot do this itself — a module never sees the
   * `INestApplication` instance — so this static helper bridges the gap.
   *
   * @param app - The Nest application returned by `NestFactory.create()`.
   * @throws Error When `BymaxLoggerModule` was not imported (no `PinoLoggerService`
   *   in the container) — a clear message instead of a cryptic DI failure. The
   *   original DI error is attached as the error `cause` so the underlying
   *   failure is preserved for debugging.
   * @example
   *   const app = await NestFactory.create(AppModule, { bufferLogs: true })
   *   BymaxLoggerModule.useNestLogger(app)
   *   await app.listen(3000)
   */
  static useNestLogger(app: INestApplication): void {
    let logger: PinoLoggerService
    try {
      // Stryker disable next-line ObjectLiteral: equivalent — the mutant replaces the literal with `{}`, and `NestApplicationContext.get` branches on `!(options && options.strict)`. An absent `strict` is `undefined`, which is falsy, so `{}` takes the same non-strict lookup across the whole module graph — the option is also this method's default. Resolution is identical for every container state, and the literal stays because it states the intent at the call site.
      logger = app.get(PinoLoggerService, { strict: false })
    } catch (cause) {
      throw new Error(
        '[BymaxLoggerModule] useNestLogger(app) called but BymaxLoggerModule was not imported',
        { cause }
      )
    }
    app.useLogger(logger)
    app.flushLogs()
  }
}
