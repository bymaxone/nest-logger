import { Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

import { LOGGER_OPTIONS_TOKEN } from './constants/injection-tokens.constants'
import type {
  BymaxLoggerModuleOptions,
  BymaxLoggerModuleOptionsFactory,
  ResolvedBymaxLoggerModuleOptions
} from './interfaces/logger-module-options.interface'
import { BymaxLoggerModule } from './logger.module'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const service = { name: 'app', version: '1.0.0' }
const CONFIG_TOKEN = Symbol('TEST_CONFIG')

/** Stub module exporting a config value so the async factory can inject it. */
@Module({
  providers: [{ provide: CONFIG_TOKEN, useValue: { level: 'warn' as const } }],
  exports: [CONFIG_TOKEN]
})
class ConfigStubModule {}

/** Factory class exercising the `useClass` async path. */
class LoggerOptionsFactory implements BymaxLoggerModuleOptionsFactory {
  createLoggerOptions(): BymaxLoggerModuleOptions {
    return { service, level: 'error' }
  }
}

describe('BymaxLoggerModule.forRootAsync', () => {
  // Silence + capture the bootstrap log across the suite.
  let infoSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    infoSpy = jest.spyOn(PinoLoggerService.prototype, 'info').mockImplementation(() => undefined)
  })

  it(/*
   * The basic useFactory path must resolve options, provide the core services,
   * expose RESOLVED (defaulted) options, and emit the bootstrap log once after
   * resolution — the headline async contract.
   */
  'resolves via useFactory, provides services, and bootstraps once', async () => {
    const ref = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRootAsync({ useFactory: () => ({ service }) })]
    }).compile()

    expect(ref.get(PinoLoggerService, { strict: false })).toBeInstanceOf(PinoLoggerService)
    expect(ref.get(LogContextService, { strict: false })).toBeInstanceOf(LogContextService)

    const options = ref.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN, {
      strict: false
    })
    expect(options.http.tenantIdHeader).toBe('x-tenant-id')

    const bootstrapCalls = infoSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK
    )
    expect(bootstrapCalls).toHaveLength(1)
    await ref.close()
  })

  it(/*
   * An async (Promise-returning) factory must be awaited before the Pino
   * instance is built.
   */
  'awaits a Promise-returning useFactory', async () => {
    const ref = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRootAsync({ useFactory: () => Promise.resolve({ service }) })]
    }).compile()
    expect(ref.get(PinoLoggerService, { strict: false })).toBeInstanceOf(PinoLoggerService)
    await ref.close()
  })

  it(/*
   * `inject` + `imports` must propagate so the factory receives dependencies
   * resolved from an imported module.
   */
  'passes injected dependencies from an imported module to the factory', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRootAsync({
          imports: [ConfigStubModule],
          inject: [CONFIG_TOKEN],
          useFactory: (config: { level: 'warn' }) => ({ service, level: config.level })
        })
      ]
    }).compile()
    const options = ref.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN, {
      strict: false
    })
    expect(options.level).toBe('warn')
    await ref.close()
  })

  it(/*
   * The `useClass` path must instantiate the factory class and call
   * `createLoggerOptions()`.
   */
  'resolves options via useClass', async () => {
    const ref = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRootAsync({ useClass: LoggerOptionsFactory })]
    }).compile()
    const options = ref.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN, {
      strict: false
    })
    expect(options.level).toBe('error')
    await ref.close()
  })

  it(/*
   * The `useExisting` path must reuse a factory provider already present in the
   * DI graph (supplied here via an imported module).
   */
  'resolves options via useExisting', async () => {
    @Module({ providers: [LoggerOptionsFactory], exports: [LoggerOptionsFactory] })
    class ExistingFactoryModule {}

    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRootAsync({
          imports: [ExistingFactoryModule],
          useExisting: LoggerOptionsFactory
        })
      ]
    }).compile()
    const options = ref.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN, {
      strict: false
    })
    expect(options.level).toBe('error')
    await ref.close()
  })

  it(/*
   * isGlobal must default to true on the async path too, matching forRoot, so a
   * single forRootAsync import exposes the logger app-wide.
   */
  'is global by default on the async path', () => {
    const dynamic = BymaxLoggerModule.forRootAsync({ useFactory: () => ({ service }) })
    expect(dynamic.global).toBe(true)
  })

  it(/*
   * Consumers must be able to scope the async module locally via isGlobal: false
   * (the async counterpart of the forRoot isGlobal test).
   */
  'honors isGlobal: false on the async path', () => {
    const dynamic = BymaxLoggerModule.forRootAsync({
      isGlobal: false,
      useFactory: () => ({ service })
    })
    expect(dynamic.global).toBe(false)
  })
})
