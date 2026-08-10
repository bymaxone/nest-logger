import { applyDefaults } from './config/default-options'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance } from './pino-factory'
import { LogContextService } from './services/log-context.service'

/** In-memory destination capturing each emitted NDJSON line as a parsed entry. */
function createCapture(name = 'capture'): {
  destination: ILogDestination
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  return {
    destination: {
      name,
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
      new LogContextService(),
      [createCapture().destination]
    )
    expect(logger.level).toBe('warn')
  })

  it(/*
   * The factory must always return a usable logger wired to the supplied
   * destinations — the branch the module uses at runtime.
   */
  'returns a usable logger wired to destinations', () => {
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      createCapture().destination
    ])
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
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
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
    const logger = buildPinoInstance(applyDefaults(baseOptions), logContext, [capture.destination])
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
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
    logger.info({ user: { password: 'secret' } }, 'x')
    const [entry] = capture.entries()
    expect((entry?.['user'] as Record<string, unknown>)['password']).toBe('[REDACTED]')
  })

  it(/*
   * A secret at the RECORD ROOT must be censored too, not only one nested a
   * level deep. `emitStructured` spreads caller metadata at the root, so this is
   * the shape the library's own `info(key, msg, userId, { password })` produces
   * — the case that previously slipped past the depth-1+ wildcards and logged in
   * clear. This pins the depth-0 redact entries that close it.
   */
  'redacts a secret at the record root (caller metadata)', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
    logger.info({ password: 'secret', accessToken: 'secret', apiKey: 'secret' }, 'x')
    const [entry] = capture.entries()
    expect(entry?.['password']).toBe('[REDACTED]')
    expect(entry?.['accessToken']).toBe('[REDACTED]')
    expect(entry?.['apiKey']).toBe('[REDACTED]')
  })

  it(/*
   * The default `err` serializer must expand Error objects into structured
   * fields (type / message / stack) for downstream parsing.
   */
  'serializes errors via the default err serializer', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
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
      [capture.destination]
    )
    logger.info({ user: { password: 'secret' } }, 'x')
    const [entry] = capture.entries()
    expect((entry?.['user'] as Record<string, unknown>)['password']).toBe('***')
  })

  it(/*
   * Multi-stream must fan every entry out to ALL registered destinations — the
   * core contract of the destination system.
   */
  'fans every entry out to every destination', () => {
    const first = createCapture('first')
    const second = createCapture('second')
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      first.destination,
      second.destination
    ])
    logger.info({ logKey: 'FAN_OUT' }, 'broadcast')
    expect(first.entries()[0]?.['msg']).toBe('broadcast')
    expect(second.entries()[0]?.['msg']).toBe('broadcast')
  })

  it(/*
   * A destination minLevel ABOVE the global level must gate that destination
   * independently: it receives only entries at/above its own threshold, while a
   * default destination still receives everything.
   */
  'honors a per-destination minLevel above the global level', () => {
    const errorsOnly = createCapture('errors-only')
    const all = createCapture('all')
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, level: 'info' }),
      new LogContextService(),
      [{ ...errorsOnly.destination, minLevel: 'error' }, all.destination]
    )
    logger.info({ logKey: 'INFO_EVT' }, 'info-msg')
    logger.error({ logKey: 'ERR_EVT' }, 'error-msg')
    expect(errorsOnly.entries().map((entry) => entry['msg'])).toEqual(['error-msg'])
    expect(all.entries().map((entry) => entry['msg'])).toEqual(['info-msg', 'error-msg'])
  })

  it(/*
   * Both the default and consumer-supplied serializers must be size-bounded:
   * an oversized custom-serialized field is replaced by the truncation envelope
   * rather than flooding the sink (verifies the LOG-047 wiring in the factory).
   */
  'size-bounds serializers and truncates oversized fields', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({
        ...baseOptions,
        maxEntrySizeBytes: 50,
        serializers: { blob: (value: unknown): unknown => value }
      }),
      new LogContextService(),
      [capture.destination]
    )
    logger.info({ blob: 'x'.repeat(500) }, 'oversized')
    const [entry] = capture.entries()
    expect((entry?.['blob'] as Record<string, unknown>)['_truncated']).toBe(true)
  })
})
