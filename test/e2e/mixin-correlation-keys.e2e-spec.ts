/**
 * E2E: a payload cannot replace the correlation keys the logger writes from the request context and
 * from the active span, so a line cannot be attributed to another request, tenant or trace. Checked
 * for an object message, for the metadata of a structured call and for the raw Pino logger, with the
 * default field names and with names set in the options. Outside any request the payload's own
 * value stays, because the logger writes no key there.
 *
 * Layer: e2e, server (`PinoLoggerService`, the trace-context mixin, the merge of the mixin result).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, LogContextService, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

type SpanStub = { spanContext: () => { traceId: string; spanId: string; traceFlags: number } }

let mockActiveSpan: SpanStub | undefined

// The SDK-detection boundary is mocked, as in the OTel spec; the validators and the whole mixin ->
// Pino -> destination pipeline run unmocked.
jest.mock('../../src/server/utils/otel-detector', () => {
  const actual = jest.requireActual('../../src/server/utils/otel-detector')
  return {
    __esModule: true,
    ...actual,
    detectOtelTraceApi: (): { getActiveSpan: () => SpanStub | undefined } => ({
      getActiveSpan: (): SpanStub | undefined => mockActiveSpan
    })
  }
})

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const SPAN_ID = 'b7ad6b7169203331'
const FORGED = 'forged-value'

class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

type Entry = Record<string, unknown>

/** Runs `act` inside a request context and returns the one entry it wrote. */
async function inRequest(
  act: (service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<Entry> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-mixin-keys', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.payloads.length
  const logContext = app.get(LogContextService, { strict: false })
  logContext.run({ requestId: 'req-real', tenantId: 'tenant-real', custom: 'store-real' }, () =>
    act(app.get(PinoLoggerService))
  )
  await app.close()
  const entries = collector.payloads
    .slice(booted)
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => !String(entry['logKey'] ?? '').startsWith('LOGGER_'))
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(`Expected one entry, got ${String(entries.length)}`)
  }
  return entry
}

const forgedStore = { requestId: FORGED, tenantId: FORGED, custom: FORGED }

describe('Logger E2E — the request context keys', () => {
  beforeEach(() => {
    mockActiveSpan = undefined
  })

  it.each([
    ['an object message', (s: PinoLoggerService) => s.warn({ event: 'LIB_EVENT', ...forgedStore })],
    [
      'the metadata of a structured call',
      (s: PinoLoggerService) => s.info('LIB_EVENT', 'text', undefined, { ...forgedStore })
    ],
    [
      'the raw Pino logger',
      (s: PinoLoggerService) => s.getRawLogger().info({ ...forgedStore }, 'text')
    ]
  ])('keeps the context values over %s', async (_label, act) => {
    const entry = await inRequest(act)

    expect(entry).toMatchObject({
      requestId: 'req-real',
      tenantId: 'tenant-real',
      custom: 'store-real'
    })
    expect(JSON.stringify(entry)).not.toContain(FORGED)
  })

  it('keeps a payload key that the context does not write', async () => {
    const entry = await inRequest((s) => s.warn({ event: 'LIB_EVENT', attempts: 3 }))

    expect(entry).toMatchObject({ attempts: 3, requestId: 'req-real' })
  })
})

describe('Logger E2E — the trace keys', () => {
  beforeEach(() => {
    mockActiveSpan = {
      spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
    }
  })

  const forgedTrace = { traceId: FORGED, spanId: FORGED, traceFlags: FORGED }

  it.each([
    ['an object message', (s: PinoLoggerService) => s.warn({ event: 'LIB_EVENT', ...forgedTrace })],
    [
      'the metadata of a structured call',
      (s: PinoLoggerService) => s.info('LIB_EVENT', 'text', undefined, { ...forgedTrace })
    ],
    [
      'the raw Pino logger',
      (s: PinoLoggerService) => s.getRawLogger().info({ ...forgedTrace }, 'text')
    ]
  ])('keeps the span ids over %s, with the default names', async (_label, act) => {
    const entry = await inRequest(act)

    expect(entry).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01' })
    expect(JSON.stringify(entry)).not.toContain(FORGED)
  })

  it('keeps the span ids over a payload that uses the names set in the options', async () => {
    const entry = await inRequest(
      (s) =>
        s.warn({ event: 'LIB_EVENT', 'my.trace': FORGED, 'my.span': FORGED, 'my.flags': FORGED }),
      { otel: { traceIdField: 'my.trace', spanIdField: 'my.span', traceFlagsField: 'my.flags' } }
    )

    expect(entry).toMatchObject({ 'my.trace': TRACE_ID, 'my.span': SPAN_ID, 'my.flags': '01' })
    expect(JSON.stringify(entry)).not.toContain(FORGED)
  })

  it('keeps the span ids over a payload that uses the snake_case names', async () => {
    const entry = await inRequest(
      (s) => s.warn({ event: 'LIB_EVENT', trace_id: FORGED, span_id: FORGED, trace_flags: FORGED }),
      { otel: { fieldFormat: 'snake_case' } }
    )

    expect(entry).toMatchObject({ trace_id: TRACE_ID, span_id: SPAN_ID, trace_flags: '01' })
    expect(JSON.stringify(entry)).not.toContain(FORGED)
  })

  it('keeps a key that only resembles the span ids as a field', async () => {
    const entry = await inRequest((s) => s.warn({ event: 'LIB_EVENT', trace_id: 'kept' }))

    expect(entry).toMatchObject({ traceId: TRACE_ID, trace_id: 'kept' })
  })
})

describe('Logger E2E — outside any request', () => {
  it('keeps the requestId a payload carries, since the logger writes none there', async () => {
    mockActiveSpan = undefined
    const collector = new Collector()

    @Module({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-mixin-keys', version: '0.0.0' },
          destinations: [collector]
        })
      ]
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
    app.useLogger(app.get(PinoLoggerService))
    new Logger('Job').warn({ event: 'LIB_EVENT', requestId: 'job-7' })
    await app.close()

    const line = collector.payloads.find((entry) => entry.includes('LIB_EVENT'))
    expect(JSON.parse(line ?? '{}')).toMatchObject({ requestId: 'job-7' })
  })
})
