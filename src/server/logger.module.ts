/**
 * `BymaxLoggerModule` — the NestJS dynamic module wiring the Pino-backed logger.
 *
 * Layer: server — extends the configurable-module base to add the runtime
 * providers (resolved options, Pino instance, destinations, services) and emit
 * the bootstrap log. Both the synchronous `forRoot` and asynchronous
 * `forRootAsync` registration paths live here and share a common provider set.
 */
import { Module } from '@nestjs/common'
import type { DynamicModule, Provider } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'

import { applyDefaults } from './config/default-options'
import { validateOptions } from './config/validate-options'
import {
  LOG_CONTEXT_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN
} from './constants/injection-tokens.constants'
import { DefaultStdoutDestination } from './destinations/default-stdout.destination'
import { HttpExceptionFilter } from './filters/http-exception.filter'
import { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
import type { ILogDestination } from './interfaces/log-destination.interface'
import type {
  BymaxLoggerModuleOptions,
  ResolvedBymaxLoggerModuleOptions
} from './interfaces/logger-module-options.interface'
import { BymaxLoggerModuleBase, BUILDER_OPTIONS_TOKEN } from './logger.module.builder'
import type { ASYNC_OPTIONS_TYPE, OPTIONS_TYPE } from './logger.module.builder'
import { buildPinoInstance } from './pino-factory'
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
 * Provider whose factory emits the `LOGGER_BOOTSTRAP_OK` log exactly once, when
 * NestJS eagerly instantiates the module's providers.
 *
 * @returns The bootstrap provider.
 */
function bootstrapProvider(): Provider {
  return {
    provide: LOGGER_BOOTSTRAP_TOKEN,
    useFactory: (logger: PinoLoggerService): boolean => {
      logger.info(RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK, 'BymaxLoggerModule initialized')
      return true
    },
    inject: [PinoLoggerService]
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
      useFactory: (options: ResolvedBymaxLoggerModuleOptions, logContext: LogContextService) =>
        buildPinoInstance(options, logContext),
      inject: [LOGGER_OPTIONS_TOKEN, LogContextService]
    },
    {
      provide: LOGGER_DESTINATIONS_TOKEN,
      useFactory: (options: ResolvedBymaxLoggerModuleOptions): readonly ILogDestination[] =>
        resolveDestinations(options),
      inject: [LOGGER_OPTIONS_TOKEN]
    },
    PinoLoggerService,
    bootstrapProvider()
  ]
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
      PinoLoggerService
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
   * Note: the destination-registry `onModuleInit` lifecycle hook is intentionally
   * deferred to Phase 4 (LOG-045), where the `DestinationRegistry` is implemented.
   * Phase 2 ships the destinations array under `LOGGER_DESTINATIONS_TOKEN`; no
   * Phase 2 destination defines an `onInit` hook, so nothing is lost.
   *
   * Note: the HTTP interceptor/filter are wired only by {@link forRoot}, where
   * `http.isEnabled` is known at module-definition time. Async options resolve at
   * runtime, after the providers array is built, so conditional global
   * registration is not possible here — consumers needing HTTP logging with async
   * config should use `forRoot`. A runtime-gated registration path is roadmap v0.2.
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
      ...buildCommonProviders()
    ]
    return augmentLoggerModule(super.forRootAsync(options), providers)
  }
}
