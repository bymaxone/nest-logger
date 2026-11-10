import { Logger, Module } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

describe('Logger E2E — useNestLogger', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service: { name: 'e2e-nest', version: '0.0.0' } })]
    }).compile()
    app = moduleRef.createNestApplication({ bufferLogs: true })
    BymaxLoggerModule.useNestLogger(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  // Installed per-test (the suite config restores mocks between tests).
  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it(/*
   * After useNestLogger, NestJS's framework Logger must emit through our
   * PinoLoggerService as structured JSON — context and service metadata included —
   * proving bootstrap-time framework logs flow through the library.
   */
  'routes the NestJS framework Logger through PinoLoggerService as structured JSON', () => {
    Logger.log('hello-from-nest', 'BootstrapCtx')

    const entry = parseLogEntries(stdoutSpy).find((item) => item['msg'] === 'hello-from-nest')
    expect(entry).toBeDefined()
    expect(entry?.['context']).toBe('BootstrapCtx')
    expect(entry?.['service']).toEqual({ name: 'e2e-nest', version: '0.0.0' })
  })
})

describe('Logger E2E — useNestLogger with the logger in a feature module', () => {
  // The lookup is non-strict on purpose. A consumer that imports the logger in a feature module
  // rather than at the root has the provider outside the host module's own injector, and a strict
  // `get` refuses it, so the helper would throw the "was not imported" error at a deployment that
  // imported it perfectly well. The root-level case above cannot tell the two apart, because
  // there the provider is local.
  it('resolves the logger from a feature module, not only from the root', async () => {
    @Module({
      imports: [BymaxLoggerModule.forRoot({ service: { name: 'e2e-feature', version: '0.0.0' } })]
    })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class RootModule {}

    const moduleRef = await Test.createTestingModule({ imports: [RootModule] }).compile()
    const app = moduleRef.createNestApplication({ bufferLogs: true })
    const useLogger = jest.spyOn(app, 'useLogger')

    expect(() => {
      BymaxLoggerModule.useNestLogger(app)
    }).not.toThrow()
    expect(useLogger).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
