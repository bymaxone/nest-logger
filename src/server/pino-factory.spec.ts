import { applyDefaults } from './config/default-options'
import { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance, resolveNameRedactor, resolveRedactOption } from './pino-factory'
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
   * The name walk runs at `formatters.log`, which does NOT see `base` or child
   * bindings. That is load-bearing: those are library-owned (`service`, the
   * `@InjectLogger` context) and must reach the sink untouched. Pinning it here
   * means a future change that starts walking them fails a test instead of
   * silently mangling every entry's service identity.
   */
  'leaves library-owned base and child bindings out of the walk', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
    logger.child({ context: 'UsersService' }).info({ password: 'secret' }, 'x')
    const [entry] = capture.entries()
    expect(entry?.['service']).toEqual({ name: 'app', version: '1.0.0' })
    expect(entry?.['context']).toBe('UsersService')
    expect(entry?.['password']).toBe('[REDACTED]')
  })

  it(/*
   * Consumer `redactPaths` are always `fast-redact` paths and must keep working
   * alongside the name walk — the walk owns the DEFAULT set, not the consumer's
   * own entries. Both must land in the same record.
   */
  'applies consumer redactPaths alongside the default name walk', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, redactPaths: ['*.ssn'] }),
      new LogContextService(),
      [capture.destination]
    )
    logger.info({ user: { ssn: 'secret', password: 'secret', name: 'ok' } }, 'x')
    const user = capture.entries()[0]?.['user'] as Record<string, unknown>
    expect(user['ssn']).toBe('[REDACTED]')
    expect(user['password']).toBe('[REDACTED]')
    expect(user['name']).toBe('ok')
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

  it(/*
   * Redaction must run BEFORE the size bound, so the 200-character `_preview` of
   * a truncated field carries the censor rather than the head of a secret. The
   * other ordering would turn the truncation envelope into a leak channel for
   * exactly the oversized payloads most likely to contain one.
   */
  'redacts a field before size-bounding it, so the preview carries no secret', () => {
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
    // The filler keeps the field oversized AFTER redaction, so the truncation
    // envelope is still produced and its preview can be inspected.
    logger.info(
      { blob: { password: 'S'.repeat(500), filler: 'x'.repeat(500) } },
      'oversized-secret'
    )
    const blob = capture.entries()[0]?.['blob'] as Record<string, unknown>
    expect(blob['_truncated']).toBe(true)
    expect(blob['_preview']).toContain('[REDACTED]')
    expect(String(blob['_preview'])).not.toContain('SSS')
  })
})

describe('resolveNameRedactor', () => {
  /** Probe payload: a secret nested past the legacy four-level ceiling. */
  const deep = { l1: { l2: { l3: { l4: { l5: { password: 'secret' } } } } } }

  it(/*
   * The default configuration must return a REAL redactor. This is the switch
   * that decides whether default PII protection exists at all, so it is asserted
   * directly — an output-level assertion cannot tell "the walk censored it" from
   * "fast-redact censored it".
   */
  'returns an active redactor under the default configuration', () => {
    const redact = resolveNameRedactor(applyDefaults(baseOptions))
    expect(redact(deep)).not.toBe(deep)
    expect(JSON.stringify(redact(deep))).not.toContain('secret')
  })

  it(/*
   * The legacy `'paths'` strategy must turn the walk OFF — otherwise the escape
   * hatch would silently keep the new semantics (unbounded depth) while claiming
   * to restore the old ones, and a consumer who chose it to reproduce a specific
   * behaviour would not get it.
   */
  'returns a pass-through under the legacy paths strategy', () => {
    const redact = resolveNameRedactor(applyDefaults({ ...baseOptions, redactStrategy: 'paths' }))
    expect(redact(deep)).toBe(deep)
  })

  it(/*
   * `shouldDisableDefaultRedact` must turn the walk off too — the opt-out has to
   * disable the DEFAULT engine whichever engine that currently is.
   */
  'returns a pass-through when the default set is disabled', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ ...baseOptions, shouldDisableDefaultRedact: true })
    )
    expect(redact(deep)).toBe(deep)
  })

  it(/*
   * Both switches off together must still be a pass-through — pins the OR, which
   * an AND mutant would turn into "walk stays on unless BOTH are set".
   */
  'returns a pass-through when both opt-outs are set', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths', shouldDisableDefaultRedact: true })
    )
    expect(redact(deep)).toBe(deep)
  })
})

describe('resolveRedactOption', () => {
  it(/*
   * Under the default strategy with no consumer paths, `fast-redact` must not be
   * configured AT ALL. This is the ~100× difference the engine change bought,
   * and it is invisible in the serialized output — both configurations censor
   * the same fields — so it can only be asserted here.
   */
  'omits the Pino redact option entirely under the default configuration', () => {
    expect(resolveRedactOption(applyDefaults(baseOptions))).toBeUndefined()
  })

  it(/*
   * Consumer paths are always `fast-redact` paths, so they MUST be forwarded —
   * and under `'names'` they must be forwarded ALONE, without the default
   * expansion the walk already covers.
   */
  'forwards only the consumer paths under the default strategy', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactPaths: ['*.ssn', '*.ssn'] })
    )
    expect(option).toEqual({ paths: ['*.ssn'], censor: '[REDACTED]' })
  })

  it(/*
   * The legacy strategy must hand Pino the full default expansion — that IS the
   * legacy engine. Asserted on the path count so a mutant that quietly drops the
   * defaults cannot pass.
   */
  'forwards the full default expansion under the legacy paths strategy', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths', redactPaths: ['*.ssn'] })
    )
    expect(option?.paths).toContain('*.ssn')
    expect(option?.paths).toContain('*.*.*.*.password')
    expect(option?.paths).toHaveLength(DEFAULT_REDACT_PATHS.length + 1)
  })

  it(/*
   * Legacy strategy with the defaults disabled: only the consumer paths survive,
   * and an empty set means no redact option at all.
   */
  'honors shouldDisableDefaultRedact under the legacy strategy', () => {
    expect(
      resolveRedactOption(
        applyDefaults({
          ...baseOptions,
          redactStrategy: 'paths',
          shouldDisableDefaultRedact: true
        })
      )
    ).toBeUndefined()
  })

  it(/*
   * A custom censor must reach the `fast-redact` config, not just the walk.
   */
  'carries the configured censor into the redact option', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactPaths: ['*.ssn'], redactCensor: '***' })
    )
    expect(option?.censor).toBe('***')
  })
})
