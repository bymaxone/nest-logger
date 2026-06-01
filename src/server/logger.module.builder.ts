/**
 * Configurable dynamic-module factory for `BymaxLoggerModule`.
 *
 * Layer: server — produces the base class that auto-generates `forRoot` and
 * `forRootAsync`. The `isGlobal` extra is mapped to the NestJS
 * `DynamicModule.global` flag, replacing a manual `@Global()` decorator.
 *
 * The builder's generated options token (`MODULE_OPTIONS_TOKEN`, re-exported as
 * `BUILDER_OPTIONS_TOKEN`) carries the RAW consumer options and stays internal
 * to the module. The public, fully-defaulted snapshot is exposed separately
 * under `LOGGER_OPTIONS_TOKEN` by the module's own providers — downstream
 * consumers (e.g. the request-id middleware) depend on defaults being applied.
 *
 * @see https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder
 */
import { ConfigurableModuleBuilder } from '@nestjs/common'

import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'

/** Extra (non-option) flags accepted by `forRoot` / `forRootAsync`. */
export interface BymaxLoggerModuleExtras {
  /** Register the module globally. Default: `true`. */
  isGlobal?: boolean
}

/**
 * `BymaxLoggerModuleBase` — base class providing the generated `forRoot` /
 * `forRootAsync` implementations.
 *
 * `BUILDER_OPTIONS_TOKEN` — internal DI token for the raw (pre-defaulted)
 * consumer options; not intended for injection outside this module.
 *
 * `OPTIONS_TYPE` / `ASYNC_OPTIONS_TYPE` — `typeof`-only sentinels used as
 * parameter types in the static factory overrides; never instantiated at
 * runtime.
 */
export const {
  ConfigurableModuleClass: BymaxLoggerModuleBase,
  MODULE_OPTIONS_TOKEN: BUILDER_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE
} = new ConfigurableModuleBuilder<BymaxLoggerModuleOptions>()
  .setClassMethodName('forRoot')
  // Align `useClass` / `useExisting` with the public `BymaxLoggerModuleOptionsFactory`
  // interface, whose method is `createLoggerOptions` (not the builder default `create`).
  .setFactoryMethodName('createLoggerOptions')
  .setExtras<BymaxLoggerModuleExtras>({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    // `setExtras` merges the `{ isGlobal: true }` default before this runs, so
    // `isGlobal` is always defined; `!== false` keeps "global unless explicitly
    // disabled" without a dead nullish branch.
    global: extras.isGlobal !== false
  }))
  .build()
