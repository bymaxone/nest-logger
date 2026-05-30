import { Logger } from '@nestjs/common'
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
