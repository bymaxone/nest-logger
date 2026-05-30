import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { TestAppModule } from './fixtures/test-app.module'
import { parseLogEntries } from './fixtures/parse-log-entries'

describe('Logger E2E — HTTP lifecycle', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
    // `logger: false` silences Nest's own banner so only library NDJSON is captured.
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  // Installed per-test: the suite config restores mocks between tests, so a
  // beforeAll spy would already be detached by the time a test runs.
  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it(/*
   * A 200 request must emit both HTTP_REQUEST_START and HTTP_REQUEST_SUCCESS —
   * the full access-log lifecycle through the real interceptor.
   */
  'logs START and SUCCESS for a 200 request', async () => {
    await request(app.getHttpServer()).get('/hello').expect(200)

    const keys = parseLogEntries(stdoutSpy).map((entry) => entry['logKey'])
    expect(keys).toContain('HTTP_REQUEST_START')
    expect(keys).toContain('HTTP_REQUEST_SUCCESS')
  })

  it(/*
   * A high-cardinality id in the path must be normalized to /users/:id so log
   * keys stay low-cardinality for aggregation.
   */
  'normalizes a UUID path param to /users/:id', async () => {
    await request(app.getHttpServer())
      .get('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736')
      .expect(200)

    const urls = parseLogEntries(stdoutSpy).map((entry) => entry['url'])
    expect(urls).toContain('/users/:id')
  })

  it(/*
   * An uncaught error must surface as HTTP_REQUEST_SERVER_ERROR and a 500 — the
   * exception is logged, never swallowed.
   */
  'logs SERVER_ERROR for an uncaught 500', async () => {
    await request(app.getHttpServer()).get('/boom').expect(500)

    const keys = parseLogEntries(stdoutSpy).map((entry) => entry['logKey'])
    expect(keys).toContain('HTTP_REQUEST_SERVER_ERROR')
  })

  it(/*
   * The excluded /health path must produce NO HTTP_REQUEST_START — monitoring
   * probes must never flood the logs (verifies excludePaths end-to-end).
   */
  'does not log the excluded /health path', async () => {
    await request(app.getHttpServer()).get('/health').expect(200)

    const healthStarts = parseLogEntries(stdoutSpy).filter(
      (entry) => entry['logKey'] === 'HTTP_REQUEST_START' && entry['url'] === '/health'
    )
    expect(healthStarts).toHaveLength(0)
  })

  it(/*
   * The x-request-id header must propagate into every log entry of the request
   * via the AsyncLocalStorage scope opened by the request-id middleware.
   */
  'propagates x-request-id across the request logs', async () => {
    await request(app.getHttpServer()).get('/hello').set('x-request-id', 'req-e2e-123').expect(200)

    const start = parseLogEntries(stdoutSpy).find(
      (entry) => entry['logKey'] === 'HTTP_REQUEST_START'
    )
    expect(start?.['requestId']).toBe('req-e2e-123')
  })

  it(/*
   * A handler logging via @InjectLogger('TestController') must stamp that context
   * onto its entries — the child-logger wiring working through real HTTP.
   */
  'stamps the @InjectLogger context onto handler logs', async () => {
    await request(app.getHttpServer()).get('/users/abc').expect(200)

    const handlerLog = parseLogEntries(stdoutSpy).find(
      (entry) => entry['logKey'] === 'USER_FETCH_OK'
    )
    expect(handlerLog?.['context']).toBe('TestController')
  })
})
