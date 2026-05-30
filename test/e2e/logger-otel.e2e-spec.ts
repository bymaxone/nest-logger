import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

/** Shape of the minimal active-span stub the OTel detector is mocked to return. */
type SpanStub = { spanContext: () => { traceId: string; spanId: string; traceFlags: number } }

/**
 * Controllable active span. A real injection requires an OTel SDK + context
 * manager (not installed — only `@opentelemetry/api`), and the api's no-op span
 * reports all-zero IDs that the validators reject. So the OTel SDK-detection
 * boundary (`detectOtelTraceApi`) is mocked while the REAL W3C validators
 * (`isValidTraceId` / `isValidSpanId`) and the whole mixin → Pino → stdout
 * pipeline run unmocked.
 */
let mockActiveSpan: SpanStub | undefined

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

/** A valid, non-zero W3C trace/span pair (the well-known spec example IDs). */
const VALID_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const VALID_SPAN_ID = 'b7ad6b7169203331'

describe('Logger E2E — OpenTelemetry trace context', () => {
  let app: INestApplication | undefined
  let stdoutSpy: jest.SpyInstance

  afterEach(async () => {
    mockActiveSpan = undefined
    if (app) {
      await app.close()
      app = undefined
    }
  })

  /**
   * Boot the module (OTel detection is captured ONCE at Pino-build time, so the
   * active span must be set before this runs) and return the resolved logger.
   */
  async function bootLogger(
    overrides: Partial<BymaxLoggerModuleOptions>
  ): Promise<PinoLoggerService> {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-otel', version: '0.0.0' },
          ...overrides
        })
      ]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    return app.get(PinoLoggerService, { strict: false })
  }

  /** Find the parsed entry carrying the given logKey. */
  function findEntry(logKey: string): Record<string, unknown> | undefined {
    return parseLogEntries(stdoutSpy).find((entry) => entry['logKey'] === logKey)
  }

  it(/*
   * With a valid active span, every entry must carry traceId / spanId
   * (camelCase defaults) and the trace flags formatted as two lowercase hex
   * digits.
   */
  'injects traceId, spanId and traceFlags from the active span (camelCase)', async () => {
    mockActiveSpan = {
      spanContext: () => ({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 })
    }
    const logger = await bootLogger({})

    logger.info('OTEL_PROBE', 'probe')

    const entry = findEntry('OTEL_PROBE')
    expect(entry?.['traceId']).toBe(VALID_TRACE_ID)
    expect(entry?.['spanId']).toBe(VALID_SPAN_ID)
    expect(entry?.['traceFlags']).toBe('01')
  })

  it(/*
   * A malformed (all-zeros) trace ID is the OTel "no trace" sentinel and a
   * potential log-injection vector — the validators must reject it so NO trace
   * fields are emitted.
   */
  'rejects an all-zero trace ID and injects nothing', async () => {
    mockActiveSpan = {
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: VALID_SPAN_ID, traceFlags: 1 })
    }
    const logger = await bootLogger({})

    logger.info('OTEL_INVALID', 'probe')

    const entry = findEntry('OTEL_INVALID')
    expect(entry?.['traceId']).toBeUndefined()
    expect(entry?.['spanId']).toBeUndefined()
  })

  it(/*
   * The `snake_case` field format must emit trace_id / span_id / trace_flags —
   * the OTel Logs Data Model wire names.
   */
  'uses snake_case field names when configured', async () => {
    mockActiveSpan = {
      spanContext: () => ({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 })
    }
    const logger = await bootLogger({ otel: { fieldFormat: 'snake_case' } })

    logger.info('OTEL_SNAKE', 'probe')

    const entry = findEntry('OTEL_SNAKE')
    expect(entry?.['trace_id']).toBe(VALID_TRACE_ID)
    expect(entry?.['span_id']).toBe(VALID_SPAN_ID)
    expect(entry?.['trace_flags']).toBe('01')
    expect(entry?.['traceId']).toBeUndefined()
  })

  it(/*
   * With `shouldAutoInjectTraceContext: false`, detection is skipped entirely —
   * no trace fields even when a valid span is active.
   */
  'injects nothing when auto-injection is disabled', async () => {
    mockActiveSpan = {
      spanContext: () => ({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 })
    }
    const logger = await bootLogger({ otel: { shouldAutoInjectTraceContext: false } })

    logger.info('OTEL_OFF', 'probe')

    expect(findEntry('OTEL_OFF')?.['traceId']).toBeUndefined()
  })

  it(/*
   * With no active span, entries carry no trace fields — the common case when
   * no request is currently traced.
   */
  'injects nothing when there is no active span', async () => {
    mockActiveSpan = undefined
    const logger = await bootLogger({})

    logger.info('OTEL_NONE', 'probe')

    expect(findEntry('OTEL_NONE')?.['traceId']).toBeUndefined()
  })
})
