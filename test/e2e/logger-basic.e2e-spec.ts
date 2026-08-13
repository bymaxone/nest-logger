import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService, RESERVED_LOG_KEYS } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

describe('Logger E2E — basic bootstrap', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance
  let bootstrapEntries: Record<string, unknown>[]

  beforeAll(async () => {
    // Spy BEFORE compile so nothing the boot emits is missed. The bootstrap
    // entries themselves are written by `DestinationRegistry.onModuleInit` — i.e.
    // during `app.init()`, AFTER every destination has been initialized — so that
    // a sink which only accepts writes post-`onInit()` cannot swallow them. They
    // are therefore collected after init, not after compile.
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service: { name: 'e2e-basic', version: '0.0.0' } })]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    bootstrapEntries = parseLogEntries(stdoutSpy)
  })

  afterAll(async () => {
    stdoutSpy.mockRestore()
    await app.close()
  })

  it(/*
   * Booting the module must emit exactly one structured bootstrap entry carrying
   * the service metadata — the signal a consumer's wiring succeeded.
   */
  'emits a single structured bootstrap log entry', () => {
    const bootstrap = bootstrapEntries.filter(
      (entry) => entry['logKey'] === RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK
    )
    expect(bootstrap).toHaveLength(1)
    expect(bootstrap[0]?.['service']).toEqual({ name: 'e2e-basic', version: '0.0.0' })
    expect(bootstrap[0]?.['msg']).toBe('BymaxLoggerModule initialized')
  })

  it(/*
   * The core service must be resolvable from the booted application container.
   */
  'exposes PinoLoggerService from the container', () => {
    expect(app.get(PinoLoggerService, { strict: false })).toBeInstanceOf(PinoLoggerService)
  })
})
