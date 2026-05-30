import { Module } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import request from 'supertest'

import { TestController } from './fixtures/test.controller'
import { parseLogEntries } from './fixtures/parse-log-entries'

/** Stub config module standing in for a real ConfigService/Vault source. */
@Module({
  providers: [{ provide: 'E2E_CONFIG', useValue: { level: 'info' as const } }],
  exports: ['E2E_CONFIG']
})
class ConfigStubModule {}

describe('Logger E2E — async configuration', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRootAsync({
          imports: [ConfigStubModule],
          inject: ['E2E_CONFIG'],
          useFactory: (config: { level: 'info' }) => ({
            service: { name: 'e2e-async', version: '0.0.0' },
            level: config.level,
            http: { isEnabled: true }
          })
        })
      ],
      controllers: [TestController]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
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
   * forRootAsync must resolve options from an injected config dependency AND wire
   * HTTP logging through the async interceptor gate — proving access-log parity
   * with the sync path end-to-end.
   */
  'boots via forRootAsync and logs HTTP through the async interceptor gate', async () => {
    await request(app.getHttpServer()).get('/hello').expect(200)

    const start = parseLogEntries(stdoutSpy).find(
      (entry) => entry['logKey'] === 'HTTP_REQUEST_START'
    )
    expect(start).toBeDefined()
    expect(start?.['service']).toEqual({ name: 'e2e-async', version: '0.0.0' })
  })
})
