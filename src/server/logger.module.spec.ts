import { Test } from '@nestjs/testing'

import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

import {
  LOG_CONTEXT_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN
} from './constants/injection-tokens.constants'
import { DefaultStdoutDestination } from './destinations/default-stdout.destination'
import type { ILogDestination } from './interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { augmentLoggerModule, BymaxLoggerModule } from './logger.module'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const service = { name: 'app', version: '1.0.0' }

describe('BymaxLoggerModule.forRoot', () => {
  // Silence the bootstrap log (and capture its calls) across the whole suite;
  // `restoreMocks: true` resets the spy between tests.
  let infoSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    infoSpy = jest.spyOn(PinoLoggerService.prototype, 'info').mockImplementation(() => undefined)
  })

  it(/*
   * forRoot must return a DynamicModule rooted at the decorated subclass (not
   * the builder base) so NestJS can resolve the module metadata.
   */
  'returns a DynamicModule rooted at BymaxLoggerModule', () => {
    const dynamic = BymaxLoggerModule.forRoot({ service })
    expect(dynamic.module).toBe(BymaxLoggerModule)
    expect(dynamic.exports).toContain(PinoLoggerService)
  })

  it(/*
   * isGlobal defaults to true so a single forRoot import makes the logger
   * available app-wide without re-importing per feature module.
   */
  'is global by default', () => {
    expect(BymaxLoggerModule.forRoot({ service }).global).toBe(true)
  })

  it(/*
   * Consumers must be able to scope the module locally via isGlobal: false.
   */
  'honors isGlobal: false', () => {
    expect(BymaxLoggerModule.forRoot({ service, isGlobal: false }).global).toBe(false)
  })

  it(/*
   * Invalid options must fail fast at registration time, not at first log.
   */
  'throws on invalid options', () => {
    expect(() => BymaxLoggerModule.forRoot({} as never)).toThrow(/service is required/)
  })

  describe('compiled module', () => {
    it(/*
     * The core services must be injectable from the compiled container.
     */
    'provides PinoLoggerService and LogContextService', async () => {
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service })]
      }).compile()
      expect(ref.get(PinoLoggerService, { strict: false })).toBeInstanceOf(PinoLoggerService)
      expect(ref.get(LogContextService, { strict: false })).toBeInstanceOf(LogContextService)
      await ref.close()
    })

    it(/*
     * LOGGER_OPTIONS_TOKEN must expose the RESOLVED (defaulted) options —
     * downstream consumers (e.g. the request-id middleware) rely on defaults
     * like http.tenantIdHeader being filled.
     */
    'exposes resolved options at LOGGER_OPTIONS_TOKEN', async () => {
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service })]
      }).compile()
      const options = ref.get<ResolvedBymaxLoggerModuleOptions>(LOGGER_OPTIONS_TOKEN, {
        strict: false
      })
      expect(options.http.tenantIdHeader).toBe('x-tenant-id')
      expect(options.redactCensor).toBe('[REDACTED]')
      await ref.close()
    })

    it(/*
     * With no consumer destinations, the module must register exactly one
     * default stdout sink so logs still go somewhere.
     */
    'defaults to a single stdout destination', async () => {
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service })]
      }).compile()
      const destinations = ref.get<readonly ILogDestination[]>(LOGGER_DESTINATIONS_TOKEN, {
        strict: false
      })
      expect(destinations).toHaveLength(1)
      expect(destinations[0]).toBeInstanceOf(DefaultStdoutDestination)
      await ref.close()
    })

    it(/*
     * Consumer-supplied destinations must replace the default sink.
     */
    'uses consumer destinations when provided', async () => {
      const custom: ILogDestination = { name: 'custom', write: () => undefined }
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service, destinations: [custom] })]
      }).compile()
      const destinations = ref.get<readonly ILogDestination[]>(LOGGER_DESTINATIONS_TOKEN, {
        strict: false
      })
      expect(destinations).toEqual([custom])
      await ref.close()
    })

    it(/*
     * LOG_CONTEXT_TOKEN is part of the public barrel, so it must resolve to the
     * same LogContextService singleton rather than throwing a DI error.
     */
    'aliases LOG_CONTEXT_TOKEN to the LogContextService singleton', async () => {
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service })]
      }).compile()
      expect(ref.get(LOG_CONTEXT_TOKEN, { strict: false })).toBe(
        ref.get(LogContextService, { strict: false })
      )
      await ref.close()
    })

    it(/*
     * The bootstrap log must be emitted exactly once at module init — a
     * regression here would either double-log startup or go silent.
     */
    'emits the bootstrap log exactly once', async () => {
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot({ service })]
      }).compile()
      const bootstrapCalls = infoSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK
      )
      expect(bootstrapCalls).toHaveLength(1)
      expect(bootstrapCalls[0]).toEqual([
        RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK,
        'BymaxLoggerModule initialized'
      ])
      await ref.close()
    })
  })

  describe('augmentLoggerModule', () => {
    it(/*
     * When the base lacks providers, augment must default to an empty list and
     * still carry over base exports (covers the providers-undefined branch).
     */
    'defaults missing base providers and preserves base exports', () => {
      const sentinel = Symbol('SENTINEL_EXPORT')
      const augmented = augmentLoggerModule({ module: BymaxLoggerModule, exports: [sentinel] }, [])
      expect(augmented.providers).toEqual([])
      expect(augmented.exports).toContain(sentinel)
      expect(augmented.exports).toContain(PinoLoggerService)
    })

    it(/*
     * When the base lacks exports, augment must default to an empty list and
     * still carry over base providers (covers the exports-undefined branch).
     */
    'defaults missing base exports and preserves base providers', () => {
      const sentinel = { provide: Symbol('SENTINEL_PROVIDER'), useValue: 1 }
      const augmented = augmentLoggerModule(
        { module: BymaxLoggerModule, providers: [sentinel] },
        []
      )
      expect(augmented.providers).toContain(sentinel)
      expect(augmented.exports).toContain(PinoLoggerService)
    })
  })
})

describe('BymaxLoggerModule.useNestLogger', () => {
  beforeEach(() => {
    // Silence the bootstrap log emitted when the module compiles.
    jest.spyOn(PinoLoggerService.prototype, 'info').mockImplementation(() => undefined)
  })

  it(/*
   * The helper must fetch PinoLoggerService from the container, install it as the
   * Nest application logger, and flush buffered bootstrap logs — the one-liner
   * main.ts wiring contract.
   */
  'wires PinoLoggerService as the Nest application logger', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service })]
    }).compile()
    const app = moduleRef.createNestApplication({ bufferLogs: true })
    const useLoggerSpy = jest.spyOn(app, 'useLogger')
    const flushLogsSpy = jest.spyOn(app, 'flushLogs')

    BymaxLoggerModule.useNestLogger(app)

    expect(useLoggerSpy).toHaveBeenCalledWith(expect.any(PinoLoggerService))
    expect(flushLogsSpy).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it(/*
   * When BymaxLoggerModule was never imported the helper must throw a clear,
   * actionable error instead of leaking a cryptic Nest DI exception. The
   * original DI error is attached as `.cause` so the underlying failure is
   * preserved for debugging — pins the `{ cause }` argument in the throw.
   */
  'throws a clear error when the module was not imported', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: 'NOOP', useValue: true }]
    }).compile()
    const app = moduleRef.createNestApplication()

    let thrown: unknown
    try {
      BymaxLoggerModule.useNestLogger(app)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      '[BymaxLoggerModule] useNestLogger(app) called but BymaxLoggerModule was not imported'
    )
    expect((thrown as Error).cause).toBeInstanceOf(Error)
    await app.close()
  })
})
