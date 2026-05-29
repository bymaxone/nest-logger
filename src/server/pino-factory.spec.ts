import { applyDefaults } from './config/default-options'
import { buildPinoInstance } from './pino-factory'
import { LogContextService } from './services/log-context.service'

/** In-memory destination capturing each emitted NDJSON line as a parsed entry. */
function createCapture(): {
  stream: { write(line: string): void }
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  return {
    stream: {
      write(line: string): void {
        lines.push(line)
      }
    },
    entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    }
  }
}

const baseOptions = { service: { name: 'app', version: '1.0.0' } }

describe('buildPinoInstance', () => {
  it(/*
   * The factory must honor the configured minimum level so consumers can
   * silence verbose logs in production.
   */
  'applies the configured level', () => {
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, level: 'warn' }),
      new LogContextService()
    )
    expect(logger.level).toBe('warn')
  })

  it(/*
   * The no-stream path must still produce a usable logger — this is the branch
   * the module uses at runtime (default stdout sink).
   */
  'returns a usable logger without an explicit stream', () => {
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService())
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.child).toBe('function')
  })

  it(/*
   * Level must serialize as a string label (not the numeric code) and every
   * entry must carry the service base bindings + a timestamp — log aggregators
   * key on these fields.
   */
  'emits string level, service base, and timestamp', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults(baseOptions),
      new LogContextService(),
      capture.stream
    )
    logger.info({ logKey: 'PROBE_OK' }, 'hello')
    const [entry] = capture.entries()
    expect(entry?.['level']).toBe('info')
    expect(entry?.['service']).toEqual({ name: 'app', version: '1.0.0' })
    expect(entry?.['msg']).toBe('hello')
    expect(typeof entry?.['time']).toBe('string')
  })

  it(/*
   * The trace mixin must merge AsyncLocalStorage context into every entry so
   * requestId / tenantId propagate without prop drilling.
   */
  'merges request context via the trace mixin', () => {
    const capture = createCapture()
    const logContext = new LogContextService()
    const logger = buildPinoInstance(applyDefaults(baseOptions), logContext, capture.stream)
    logContext.run({ requestId: 'r_1', tenantId: 't_1' }, () => logger.info('inside'))
    const [entry] = capture.entries()
    expect(entry?.['requestId']).toBe('r_1')
    expect(entry?.['tenantId']).toBe('t_1')
  })

  it(/*
   * Default redact paths must censor nested secrets so PII never reaches the
   * sink. Protects the security-critical default redaction wiring.
   */
  'redacts default PII paths', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults(baseOptions),
      new LogContextService(),
      capture.stream
    )
    logger.info({ user: { password: 'secret' } }, 'x')
    const [entry] = capture.entries()
    expect((entry?.['user'] as Record<string, unknown>)['password']).toBe('[REDACTED]')
  })

  it(/*
   * The default `err` serializer must expand Error objects into structured
   * fields (type / message / stack) for downstream parsing.
   */
  'serializes errors via the default err serializer', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults(baseOptions),
      new LogContextService(),
      capture.stream
    )
    logger.error({ err: new Error('boom') }, 'failed')
    const [entry] = capture.entries()
    const err = entry?.['err'] as Record<string, unknown>
    expect(err['type']).toBe('Error')
    expect(err['message']).toBe('boom')
    expect(typeof err['stack']).toBe('string')
  })

  it(/*
   * A custom censor string must override the default so consumers can match
   * their own log-scrubbing conventions.
   */
  'honors a custom redact censor', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, redactCensor: '***' }),
      new LogContextService(),
      capture.stream
    )
    logger.info({ user: { password: 'secret' } }, 'x')
    const [entry] = capture.entries()
    expect((entry?.['user'] as Record<string, unknown>)['password']).toBe('***')
  })
})
