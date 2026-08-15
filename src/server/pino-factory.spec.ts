import { applyDefaults } from './config/default-options'
import { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
import type { ILogDestination } from './interfaces/log-destination.interface'
import {
  buildPinoInstance as buildPinoInstanceWithHealth,
  leafNameOf,
  resolveNameRedactor,
  resolveRedactOption,
  serializeErrorValue,
  withEventName,
  withSemconvException
} from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'

/**
 * `buildPinoInstance` with a fresh, all-healthy `DestinationHealth`.
 *
 * Every case below exercises the fan-out with destinations that initialized, so
 * the health record is uniform noise at these call sites. The health-aware
 * behaviour (a failed sink skipped, a total failure rescued to stdout) belongs to
 * the wrapper and is asserted in `destination-to-stream.spec.ts` against the
 * record directly, rather than through a Pino instance that cannot observe it.
 */
function buildPinoInstance(
  options: ResolvedBymaxLoggerModuleOptions,
  logContext: LogContextService,
  destinations: readonly ILogDestination[],
  health: DestinationHealth = new DestinationHealth()
): ReturnType<typeof buildPinoInstanceWithHealth> {
  return buildPinoInstanceWithHealth(options, logContext, destinations, health)
}

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
   * REGRESSION — `service` is CONSUMER-supplied and `applyDefaults` keeps whatever
   * it was handed, so a `{ name, version, apiKey }` reached the sink in clear once
   * base bindings stopped going through the path expansion that had covered it
   * via `*.*.apiKey`. Redacted at `formatters.bindings`, which is where Pino
   * hands base over — once, at construction.
   */
  'redacts a sensitive field a consumer put on service metadata', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({
        service: { name: 'app', version: '1.0.0', apiKey: 'secret' }
      } as unknown as Parameters<typeof applyDefaults>[0]),
      new LogContextService(),
      [capture.destination]
    )

    logger.info({}, 'x')

    const service = capture.entries()[0]?.['service'] as Record<string, unknown>
    expect(service['apiKey']).toBe('[REDACTED]')
    expect(service['name']).toBe('app')
    expect(service['version']).toBe('1.0.0')
  })

  it(/*
   * Redacting base rather than trimming it to the two declared fields is a
   * deliberate choice: a consumer's extra, non-sensitive metadata must survive
   * rather than be silently dropped.
   */
  'keeps non-sensitive extra service metadata', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({
        service: { name: 'app', version: '1.0.0', region: 'sa-east-1' }
      } as unknown as Parameters<typeof applyDefaults>[0]),
      new LogContextService(),
      [capture.destination]
    )

    logger.info({}, 'x')

    expect((capture.entries()[0]?.['service'] as Record<string, unknown>)['region']).toBe(
      'sa-east-1'
    )
  })

  it(/*
   * The three binding surfaces reach the sink together, each redacted by its own
   * hook: `base` at `formatters.bindings`, the record at `formatters.log`, and
   * child bindings inside `PinoLoggerService.child()` — Pino pre-serializes the
   * last two into `chindings`, so no factory hook can reach them.
   *
   * Note what this does NOT cover: bindings passed to the RAW Pino logger's
   * `child()`. `getRawLogger()` is the documented escape hatch and keeps raw
   * semantics; the redacted path is `PinoLoggerService.child()`, pinned in that
   * service's spec.
   */
  'carries base, child and record fields through together', () => {
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
   * REGRESSION — the ROOT of a log record must never honour a `toJSON` method.
   * Pino ITERATES that object rather than serializing it, so returning the
   * method's result replaced the entire record: `logger.info(key, msg, userId,
   * { toJSON: () => 'x' })` emitted `{"0":"x"}` and lost logKey, userId and
   * every other field. Nested values keep `toJSON`, because those DO reach
   * `JSON.stringify`.
   */
  'keeps the record intact when caller metadata carries a toJSON', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])

    logger.info({ toJSON: (): string => 'x', logKey: 'REAL_KEY', orderId: 'o_1' }, 'msg')

    const [entry] = capture.entries()
    expect(entry?.['logKey']).toBe('REAL_KEY')
    expect(entry?.['orderId']).toBe('o_1')
    expect(entry?.['msg']).toBe('msg')
    expect(entry).not.toHaveProperty('0')
  })

  it(/*
   * The root exception must NOT leak into the serializer hook. A serializer's
   * output does reach `JSON.stringify`, so a `toJSON` on it is honoured — and a
   * serializer that synthesizes such an object is the one shape where skipping
   * it would emit the secret verbatim.
   */
  'honors toJSON on a serializer output', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({
        ...baseOptions,
        serializers: {
          account: (): unknown => ({ toJSON: (): unknown => ({ password: 'secret' }) })
        }
      }),
      new LogContextService(),
      [capture.destination]
    )

    logger.info({ account: { id: 'a1' } }, 'msg')

    const account = capture.entries()[0]?.['account'] as Record<string, unknown>
    expect(account['password']).toBe('[REDACTED]')
  })

  it(/*
   * SECURITY — the serializer's output is redacted under `redactStrategy:
   * 'paths'` too, which is NOT what that option controls.
   *
   * Carrying own properties at every depth (1.2.7) opened a hole here and the
   * suite did not see it: under `'paths'` the name walk is a pass-through, so
   * redaction fell to `fast-redact` and `DEFAULT_REDACT_PATHS` reaches
   * `*.*.*.*.password` — four wildcard levels. A password on the deepest link of
   * `err.errors[0].cause.cause` sits below that ceiling, and it was emitted in
   * clear. Measured on the built artifact, and confirmed absent from 1.2.6 —
   * where the field was not carried at all — so it was a regression this release
   * introduced rather than one it inherited.
   *
   * The strategy is the consumer's choice about THEIR OWN payload; what a
   * serializer synthesizes is this library's output, and the name walk (which has
   * no depth ceiling) covers it either way.
   */
  'redacts serializer output even under the legacy paths strategy', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths' }),
      new LogContextService(),
      [capture.destination]
    )
    const deep = Object.assign(new Error('deep'), { password: 'LEAK-deep' })
    const member = new Error('member', { cause: new Error('mid', { cause: deep }) })

    logger.error({ err: new AggregateError([member], 'all failed') }, 'msg')

    const line = JSON.stringify(capture.entries()[0])
    expect(line).not.toContain('LEAK-deep')
    expect(line).toContain('[REDACTED]')
  })

  it(/*
   * SECURITY — an error's own properties now travel at EVERY depth of the cause
   * chain (1.2.7), which widened what reaches a sink: a secret attached to an
   * error two levels down used to be dropped by accident, and is now carried on
   * purpose. Redaction has to reach it, or the fix would have opened a leak
   * while closing an observability gap.
   *
   * Asserted through the wired factory rather than the serializer alone, because
   * the property belongs to the composition — `size-bound(redact(serialize))` —
   * and a serializer that stopped being wrapped would still pass a direct test.
   */
  'redacts an own property carried on a nested cause', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])
    const inner = Object.assign(new Error('auth failed'), {
      password: 'hunter2',
      apiKey: 'sk-live-123',
      safe: 'keep-me'
    })

    logger.error({ err: new Error('outer', { cause: inner }) }, 'msg')

    const cause = (capture.entries()[0]?.['err'] as Record<string, unknown>)['cause'] as Record<
      string,
      unknown
    >
    expect(cause['password']).toBe('[REDACTED]')
    expect(cause['apiKey']).toBe('[REDACTED]')
    // The point of carrying them at all: a non-secret field still arrives.
    expect(cause['safe']).toBe('keep-me')
  })

  it(/*
   * The converse, so the root exception stays surgical: a NESTED value with a
   * `toJSON` is still inspected through that method, because `JSON.stringify`
   * will call it.
   */
  'still redacts through toJSON on a nested value', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])

    logger.info({ nested: { toJSON: (): unknown => ({ password: 'secret' }) } }, 'msg')

    const nested = capture.entries()[0]?.['nested'] as Record<string, unknown>
    expect(nested['password']).toBe('[REDACTED]')
  })

  it(/*
   * REGRESSION — `formatters.log` is not the first code to read the caller's
   * object: Pino merges the mixin result with it first, and the default strategy's
   * `Object.assign` invokes every own getter. A throwing getter therefore crashed
   * the log call before the redactor could return its fail-closed envelope. The
   * factory now owns the merge so the guarantee actually holds through the real
   * pipeline.
   */
  'contains a throwing getter on the caller object instead of crashing', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])

    expect(() =>
      logger.info(
        {
          get boom(): never {
            throw new Error('hostile getter')
          }
        },
        'x'
      )
    ).not.toThrow()

    const [entry] = capture.entries()
    expect(entry?.['_redactionFailed']).toBe(true)
    expect(entry?.['msg']).toBe('x')
  })

  it(/*
   * REGRESSION — the record is dropped WHOLE, not up to the property that threw.
   * `Object.assign` copies key by key, so merging into the mixin's own object left
   * everything read before the hostile getter already written into it, and the
   * failure path then emitted that prefix. The field used here is deliberately
   * NOT a sensitive name: the name walk would have censored one that was, which
   * is exactly what made the prefix easy to miss.
   */
  'drops the whole record when a getter throws, not just the failing property', () => {
    const capture = createCapture()
    const logContext = new LogContextService()
    const logger = buildPinoInstance(applyDefaults(baseOptions), logContext, [capture.destination])

    logContext.run({ requestId: 'r_1' }, () => {
      logger.info(
        {
          apiToken: 'must-not-appear',
          get boom(): never {
            throw new Error('hostile getter')
          }
        },
        'x'
      )
    })

    const [entry] = capture.entries()
    expect(entry).not.toHaveProperty('apiToken')
    expect(entry?.['_redactionFailed']).toBe(true)
    // The mixin's own ambient context is library-produced and survives.
    expect(entry?.['requestId']).toBe('r_1')
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
   * The legacy `'paths'` strategy is the one configuration where Pino's own
   * `redact` option is load-bearing: the name walk is off, so dropping the option
   * would silence redaction entirely. Asserted here at unit level because that is
   * what mutation testing can see.
   */
  'wires Pino redact so the legacy paths strategy still censors', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths' }),
      new LogContextService(),
      [capture.destination]
    )

    logger.info({ user: { password: 'secret' } }, 'x')

    expect((capture.entries()[0]?.['user'] as Record<string, unknown>)['password']).toBe(
      '[REDACTED]'
    )
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

describe('leafNameOf', () => {
  it.each([
    ['user.ssn', 'ssn'],
    ['*.password', 'password'],
    ['*.*.*.*.password', 'password'],
    ['req.headers["x-api-key"]', 'x-api-key'],
    ["req.headers['x-auth-token']", 'x-auth-token'],
    ['arr[*].secret', 'secret'],
    ['token', 'token'],
    // A key may legitimately contain a dot. Rewriting the bracket into dotted
    // text yielded `security` — a name that does not exist in the payload, while
    // the one that does went uncovered.
    ['blob["social.security"]', 'social.security'],
    ['a["b.c"].d', 'd'],
    // A trailing separator leaves an EMPTY final segment. Without the
    // length guard the leaf would be `''`, a name that matches nothing and
    // silently drops the consumer's declaration.
    ['user.', 'user'],
    ['a..b', 'b'],
    // REGRESSION — an UNQUOTED numeric segment is an array index, not a field
    // name. `tokens[0]` used to yield `0`, which covered nothing (the walk never
    // compares array positions, so the element stayed raw through the size-bound
    // preview) while censoring any object key literally named `0`. It now falls
    // back to the nearest name, censoring the whole array.
    ['tokens[0]', 'tokens'],
    ['a.b[2].secret', 'secret'],
    ['creds.0.password', 'password'],
    ['sessions.0', 'sessions'],
    // The QUOTED form is explicit key syntax, not an index, and an object key
    // named `0` IS matched by the walk — so it stays a name.
    ['obj["0"]', '0']
  ])(
    /*
     * The leaf is the last segment that names something: wildcards and empty
     * segments are not names, and bracket syntax spells a key that is not a bare
     * identifier. Each case is a shape `fast-redact` actually accepts.
     */
    'reads the leaf name out of %s',
    (path, expected) => {
      expect(leafNameOf(path)).toBe(expected)
    }
  )

  it.each([['*'], ['*.*'], ['.'], [''], ['[0]'], ['0.1']])(
    /*
     * A path with no nameable segment yields NO leaf — not the wildcard itself.
     * Returning `'*'` would put a name in the matcher that can never match, which
     * is worse than nothing: it makes the set non-empty and buys a traversal that
     * cannot censor anything.
     */
    'yields no leaf for %s',
    (path) => {
      expect(leafNameOf(path)).toBeUndefined()
    }
  )
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
   * A path with no nameable segment yields no leaf, and with the defaults off
   * that leaves nothing for the walk to match — so it must fall back to the
   * pass-through rather than build an empty matcher and pay for the traversal.
   */
  'returns a pass-through when no path yields a leaf name and defaults are off', () => {
    const redact = resolveNameRedactor(
      applyDefaults({
        ...baseOptions,
        shouldDisableDefaultRedact: true,
        redactPaths: ['*', '*.*']
      })
    )
    const input = { password: 'kept' }
    expect(redact(input)).toBe(input)
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

it(/*
 * REGRESSION — consumer `redactPaths` are applied by Pino's stringifier, which
 * runs AFTER the serializer wrapper. A field covered only by a path was still
 * raw when the size bound built its 200-character `_preview`, so an oversized
 * value leaked its secret there. The path's LEAF NAME now reaches the walk.
 */
'keeps a consumer-path field out of an oversized value preview', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      maxEntrySizeBytes: 60,
      redactPaths: ['blob.ssn'],
      serializers: { blob: (value: unknown): unknown => value }
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ blob: { ssn: 'SECRET-123', filler: 'x'.repeat(400) } }, 'x')

  const blob = capture.entries()[0]?.['blob'] as Record<string, unknown>
  expect(blob['_truncated']).toBe(true)
  expect(String(blob['_preview'])).toContain('[REDACTED]')
  expect(String(blob['_preview'])).not.toContain('SECRET')
})

it(/*
 * The leaf name is taken from bracket syntax too, which is how `fast-redact`
 * spells a key that is not a bare identifier.
 */
'reads the leaf name out of a bracketed consumer path', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({ ...baseOptions, redactPaths: ['req.headers["x-custom-token"]'] }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ elsewhere: { 'x-custom-token': 'secret' } }, 'x')

  const elsewhere = capture.entries()[0]?.['elsewhere'] as Record<string, unknown>
  expect(elsewhere['x-custom-token']).toBe('[REDACTED]')
})

it(/*
 * REGRESSION — end to end for a dotted key: the consumer declares
 * `blob["social.security"]` secret, and the walk must match that exact name, so
 * the value stays out of an oversized field's truncation preview.
 */
'covers a bracketed key containing a dot', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      maxEntrySizeBytes: 60,
      redactPaths: ['blob["social.security"]'],
      serializers: { blob: (value: unknown): unknown => value }
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ blob: { 'social.security': 'SECRET-123', filler: 'x'.repeat(400) } }, 'x')

  const blob = capture.entries()[0]?.['blob'] as Record<string, unknown>
  expect(blob['_truncated']).toBe(true)
  expect(String(blob['_preview'])).toContain('[REDACTED]')
  expect(String(blob['_preview'])).not.toContain('SECRET')
})
it(/*
 * With the defaults disabled, a consumer path's leaf name is still honoured —
 * the opt-out drops the library's set, not the consumer's own declaration.
 */
'honors consumer path names when the default set is disabled', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      shouldDisableDefaultRedact: true,
      redactPaths: ['*.ssn']
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ user: { ssn: 'secret', password: 'by-design' } }, 'x')

  const user = capture.entries()[0]?.['user'] as Record<string, unknown>
  expect(user['ssn']).toBe('[REDACTED]')
  expect(user['password']).toBe('by-design')
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

describe('event name derivation', () => {
  /** Emit one structured entry and one variadic entry, returning both records. */
  function emit(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, ...overrides }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('PAYMENT_FAILED', 'Payment failed')
    logger.log('a plain nest-style message')
    return capture.entries()
  }

  it(/*
   * The event name is DERIVED, not mirrored. OTel's naming rules call for
   * lowercase dot-namespaced names, so emitting `PAYMENT_FAILED` verbatim would
   * produce a non-conforming event name and defeat the point of the field.
   * `logKey` itself is untouched — this is additive, never a rename.
   */
  'derives a lowercase dotted name and leaves logKey alone', () => {
    const [structured] = emit()

    expect(structured?.['event.name']).toBe('payment.failed')
    expect(structured?.['logKey']).toBe('PAYMENT_FAILED')
  })

  it(/*
   * The NestJS variadic bridge carries no log key, and an ordinary diagnostic
   * line is not an Event — so it correctly gets no event name rather than an
   * empty or fabricated one.
   */
  'omits the event name on calls that carry no log key', () => {
    const [, variadic] = emit()

    expect(variadic?.['event.name']).toBeUndefined()
    expect(variadic?.['msg']).toBe('a plain nest-style message')
  })

  it(/*
   * The field name is configurable because the value is meant to be mapped onto
   * the LogRecord's `EventName` field, and different pipelines read different
   * keys. The same-named OTLP *attribute* is deprecated, which is exactly why
   * the carrier key must not be hard-coded.
   */
  'honours a custom field name', () => {
    const [structured] = emit({ eventNameField: 'otel.event_name' })

    expect(structured?.['otel.event_name']).toBe('payment.failed')
    expect(structured?.['event.name']).toBeUndefined()
  })

  it(/*
   * `false` is a meaningful value, not an absent one — `??` in the defaults is
   * what preserves it, where `||` would silently restore the default.
   */
  'emits nothing when disabled', () => {
    const [structured] = emit({ eventNameField: false })

    expect(structured?.['event.name']).toBeUndefined()
    expect(structured?.['logKey']).toBe('PAYMENT_FAILED')
  })

  it.each([
    ['USER_AUTHENTICATION_FAILED', 'user.authentication.failed'],
    ['LOGGER_BOOTSTRAP_OK', 'logger.bootstrap.ok'],
    ['SINGLE', 'single']
  ])(
    /*
     * The mapping is exactly reversible for the `MODULE_ACTION_RESULT`
     * convention the library already enforces on log keys.
     */
    'maps %s to %s',
    (logKey, expected) => {
      const capture = createCapture()
      const logger = new PinoLoggerService(
        buildPinoInstance(
          applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
          new LogContextService(),
          [capture.destination]
        )
      )
      logger.info(logKey, 'message')

      expect(capture.entries()[0]?.['event.name']).toBe(expected)
    }
  )
})

describe('err serializer', () => {
  /** Emit one error entry and return the serialized `err` object. */
  function serializeThrough(
    value: unknown,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, ...overrides }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.errorStructured('OPERATION_FAILED', value as Error)
    return capture.entries()[0]?.['err'] as Record<string, unknown>
  }

  it(/*
   * REGRESSION — the defect the audit named. `pino.stdSerializers.err` derives
   * `type` from the value's CONSTRUCTOR, so anything already normalized into a
   * plain object — which is exactly what `HttpExceptionFilter` produces — came
   * out as `type: "Object"`. Every `ForbiddenException` in every error log was
   * mislabelled, and the earlier fix that read `error.name` was defeated one
   * layer below it.
   */
  'reports the real type for a plain error-like object, never "Object"', () => {
    const err = serializeThrough({ name: 'ForbiddenException', message: 'denied', stack: 'at x' })

    expect(err['type']).toBe('ForbiddenException')
    expect(err['type']).not.toBe('Object')
    expect(err['message']).toBe('denied')
  })

  it('reports the real type for a subclassed Error', () => {
    class PaymentDeclined extends Error {}
    const err = serializeThrough(new PaymentDeclined('card declined'))

    expect(err['type']).toBe('Error')
    expect(err['message']).toBe('card declined')
  })

  it(/*
   * A custom `name` is what typed exceptions set, and it must win over the
   * constructor — that is the whole distinction the regression erased.
   */
  'prefers a custom name over the constructor', () => {
    const error = new Error('denied')
    error.name = 'ForbiddenException'

    expect(serializeThrough(error)['type']).toBe('ForbiddenException')
  })

  it(/*
   * REGRESSION — `sanitizeError` computed the cause chain and the service threw
   * it away, so `Error.cause` never reached a log line. Modern JavaScript error
   * chaining was invisible in production.
   */
  'preserves an Error.cause chain', () => {
    const err = serializeThrough(
      new Error('outer', { cause: new Error('middle', { cause: new Error('root') }) })
    )

    const cause = err['cause'] as Record<string, unknown>
    expect(cause['message']).toBe('middle')
    expect((cause['cause'] as Record<string, unknown>)['message']).toBe('root')
  })

  it('preserves AggregateError members', () => {
    const err = serializeThrough(
      new AggregateError([new Error('first'), new Error('second')], 'both failed')
    )

    const members = err['errors'] as Record<string, unknown>[]
    expect(members).toHaveLength(2)
    expect(members[0]?.['message']).toBe('first')
  })

  it(/*
   * A cause cycle must not hang the serializer. The walk is circular-safe, and
   * this is the shape that would otherwise recurse forever.
   */
  'collapses a circular cause rather than recursing', () => {
    const outer = new Error('outer')
    const inner = new Error('inner')
    Object.defineProperty(outer, 'cause', { value: inner, enumerable: false })
    Object.defineProperty(inner, 'cause', { value: outer, enumerable: false })

    expect(() => serializeThrough(outer)).not.toThrow()
    expect(JSON.stringify(serializeThrough(outer))).toContain('Circular')
  })

  it(/*
   * `name`, `message` and `stack` are ordinary properties a caller can redefine
   * as throwing accessors — V8 already exposes `stack` as one. The record must
   * degrade rather than take the process down.
   *
   * The degradation happens at the REDACTION hook, which runs before the
   * serializer: a value that cannot be read cannot be proven safe, so the whole
   * record is dropped and marked rather than partially emitted. Asserting the
   * serializer's own `SanitizeFailed` envelope here would assert a path this
   * input never reaches — the fail-closed guard gets there first, which is the
   * stronger outcome.
   */
  'degrades a hostile error to a marked record instead of throwing', () => {
    const hostile = new Error('boom')
    Object.defineProperty(hostile, 'message', {
      get(): never {
        throw new Error('hostile message')
      }
    })
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )

    expect(() => {
      logger.errorStructured('OPERATION_FAILED', hostile)
    }).not.toThrow()

    const entry = capture.entries()[0]
    expect(entry?.['_redactionFailed']).toBe(true)
    expect(entry?.['_logKey']).toBe('LOGGER_REDACTION_FAILED')
  })

  it(/*
   * The serializer's own never-throw guard, asserted where it actually runs.
   *
   * Going through the sink did NOT exercise this: a non-enumerable `stack` is
   * dropped by the redaction snapshot before the serializer ever reads it, so
   * the previous version of this test asserted `not.toThrow()` on a path that
   * never had a chance to throw — green while proving nothing. Calling the
   * serializer directly reaches the guard, and the envelope is asserted on its
   * exact content rather than its type, because an empty stand-in would be
   * indistinguishable from a genuinely empty error.
   */
  'degrades to the SanitizeFailed envelope when reading the value throws', () => {
    const hostile = { name: 'Weird', message: 'readable' }
    Object.defineProperty(hostile, 'stack', {
      get(): never {
        throw new Error('hostile stack')
      },
      enumerable: false
    })

    let serialized: Record<string, unknown> | undefined
    expect(() => {
      serialized = serializeErrorValue(hostile)
    }).not.toThrow()
    expect(serialized).toEqual({
      type: 'SanitizeFailed',
      message: 'Failed to sanitize the thrown value'
    })
  })

  it(/*
   * The legacy key names are what every existing query, dashboard and alert
   * reads. The cause chain is additive on top of them, never a rename.
   */
  'keeps the legacy type/message/stack key names', () => {
    const err = serializeThrough(new Error('boom'))

    expect(Object.keys(err).sort()).toEqual(['message', 'stack', 'type'])
  })
})

describe('errorFormat', () => {
  /** Emit one error entry under the given format and return the whole record. */
  function emitError(errorFormat: 'pino' | 'semconv' | 'both'): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat }),
        new LogContextService(),
        [capture.destination]
      )
    )
    const error = new Error('card declined')
    error.name = 'PaymentDeclined'
    logger.errorStructured('PAYMENT_FAILED', error)
    return capture.entries()[0] as Record<string, unknown>
  }

  it(/*
   * The DEFAULT must not change what an existing consumer sees. `err.*` is what
   * every dashboard, alert and LogQL query already reads, so the semconv
   * attributes are opt-in rather than a silent addition to every record.
   */
  'emits only the legacy err object by default', () => {
    const entry = emitError('pino')

    expect(entry['err']).toMatchObject({ type: 'PaymentDeclined', message: 'card declined' })
    expect(entry['exception.type']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })

  it(/*
   * All four attributes are Stable in SemConv v1.44.0. The spec requires at
   * least one of `exception.type` / `exception.message`; both are present here
   * because both come from the same value.
   */
  'emits the stable semconv attributes in semconv mode', () => {
    const entry = emitError('semconv')

    expect(entry['exception.type']).toBe('PaymentDeclined')
    expect(entry['exception.message']).toBe('card declined')
    expect(entry['exception.stacktrace']).toEqual(expect.any(String))
    expect(entry['error.type']).toBe('PaymentDeclined')
  })

  it(/*
   * REGRESSION — the legacy object is rebuilt out rather than `delete`d: the
   * redaction walk defines every property of its snapshot as non-configurable,
   * so `delete` throws `TypeError` and, caught, would silently leave `err` in
   * place. Measured behaviour, not an assumption about Pino.
   */
  'removes the legacy err object in semconv mode', () => {
    const entry = emitError('semconv')

    expect(entry).not.toHaveProperty('err')
    // …and the rest of the record survives the rebuild.
    expect(entry['logKey']).toBe('PAYMENT_FAILED')
    expect(entry['msg']).toBe('card declined')
  })

  it(/*
   * The migration path: nothing breaks and the new fields are already there, so
   * dashboards can move over one at a time.
   */
  'emits both shapes in both mode', () => {
    const entry = emitError('both')

    expect(entry['err']).toMatchObject({ type: 'PaymentDeclined' })
    expect(entry['exception.type']).toBe('PaymentDeclined')
    expect(entry['error.type']).toBe('PaymentDeclined')
  })

  it(/*
   * `error.type` must stay LOW cardinality — the spec is explicit that it
   * "SHOULD be predictable, and SHOULD have low cardinality". It carries the
   * class name, which is bounded by how many exception types a codebase defines;
   * putting the message there would make it unbounded and useless to aggregate.
   */
  'keeps error.type to the class name, never the message', () => {
    const entry = emitError('both')

    expect(entry['error.type']).toBe('PaymentDeclined')
    expect(entry['error.type']).not.toBe('card declined')
  })

  it(/*
   * An entry with no error must not gain empty exception attributes — an absent
   * attribute and one holding `undefined` mean different things to a consumer.
   */
  'adds nothing to an entry that carries no error', () => {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat: 'both' }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('USER_CREATED', 'created')

    const entry = capture.entries()[0] as Record<string, unknown>
    expect(entry['exception.type']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })
})

describe('semconv attributes — degenerate errors', () => {
  /** Emit an entry whose `err` field holds the given value. */
  function emitWithErr(err: unknown): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat: 'both' }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('OPERATION_FAILED', 'message', undefined, { err })
    return capture.entries()[0] as Record<string, unknown>
  }

  it(/*
   * An `err` that carries none of the three readable fields must produce NO
   * exception attributes rather than attributes holding `undefined`. The spec
   * requires at least one of `exception.type` / `exception.message` to be
   * present, so emitting neither is the only correct answer for a value that has
   * neither — a half-populated set would assert something false.
   */
  'emits no exception attributes for an error-shaped value with no readable fields', () => {
    const entry = emitWithErr({ unrelated: 1 })

    expect(entry['exception.type']).toBeUndefined()
    expect(entry['exception.message']).toBeUndefined()
    expect(entry['exception.stacktrace']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })

  it.each([['a string'], [42], [null]])(
    /*
     * A non-object `err` cannot carry exception attributes and must not crash the
     * hook that reads it.
     */
    'ignores a non-object err (%p)',
    (err) => {
      const entry = emitWithErr(err)

      expect(entry['exception.type']).toBeUndefined()
      expect(entry['logKey']).toBe('OPERATION_FAILED')
    }
  )

  it(/*
   * A value with a name but no message still yields the attributes it can
   * support — the spec's requirement is that at least ONE of type/message be
   * present, not both.
   */
  'emits only the attributes the value can support', () => {
    const entry = emitWithErr({ name: 'PartialError' })

    expect(entry['exception.type']).toBe('PartialError')
    expect(entry['error.type']).toBe('PartialError')
    expect(entry['exception.message']).toBeUndefined()
    expect(entry['exception.stacktrace']).toBeUndefined()
  })
})

describe('err serializer — field presence', () => {
  /** Serialize a value through a real instance and return the `err` object. */
  function errOf(value: unknown): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.errorStructured('OPERATION_FAILED', value as Error)
    return capture.entries()[0]?.['err'] as Record<string, unknown>
  }

  it(/*
   * An absent field must be ABSENT, not present holding `undefined`. A consumer
   * cannot distinguish `"cause": null` from a cause that genuinely was null, and
   * `JSON.stringify` drops `undefined` silently — so the only way this stays
   * honest is to never write the key.
   */
  'omits cause and errors for an error that has neither', () => {
    const err = errOf(new Error('plain'))

    expect(Object.keys(err)).not.toContain('cause')
    expect(Object.keys(err)).not.toContain('errors')
  })

  it('omits stack for an error-like value that has none', () => {
    const err = errOf({ name: 'NoStack', message: 'no stack here' })

    expect(Object.keys(err)).not.toContain('stack')
    expect(err['type']).toBe('NoStack')
  })

  it(/*
   * REGRESSION — `pino.stdSerializers.err` copied an error's own enumerable
   * properties, and applications rely on it: Node puts `code` on system errors,
   * HTTP layers put `statusCode`, domain code attaches its own fields. Dropping
   * them when the serializer was replaced would have been a silent compatibility
   * loss.
   */
  'copies an error own enumerable properties', () => {
    const error = Object.assign(new Error('failed'), { code: 'ECONNREFUSED', attempt: 3 })

    const err = errOf(error)

    expect(err['code']).toBe('ECONNREFUSED')
    expect(err['attempt']).toBe(3)
  })

  it(/*
   * An own property must never shadow a field the serializer owns. An error
   * carrying `type` would otherwise overwrite the real error type — reintroducing
   * exactly the mislabelling this serializer exists to fix.
   */
  'does not let an own property shadow the serialized type', () => {
    const error = Object.assign(new Error('failed'), { type: 'IMPOSTOR' })

    expect(errOf(error)['type']).toBe('Error')
  })
})

describe('event name — degenerate log keys', () => {
  it(/*
   * An empty log key is not an event. Deriving from it would put `""` on the
   * entry, which is worse than absence: it asserts the record IS an Event and
   * names it nothing.
   */
  'emits no event name for an empty log key', () => {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('', 'message with no key')

    const entry = capture.entries()[0]
    expect(entry?.['event.name']).toBeUndefined()
  })
})

describe('serializeErrorValue (direct)', () => {
  it(/*
   * Asserted on the RETURNED object rather than through the sink. A field
   * written as `undefined` disappears from the serialized line — `JSON.stringify`
   * drops it — so a sink-level assertion cannot tell "omitted" from "written as
   * undefined". Mutation testing is what surfaced the gap.
   */
  'omits stack, cause and errors rather than writing them as undefined', () => {
    const serialized = serializeErrorValue({ name: 'Bare', message: 'no extras' })

    expect(Object.keys(serialized).sort()).toEqual(['message', 'type'])
    expect('stack' in serialized).toBe(false)
    expect('cause' in serialized).toBe(false)
    expect('errors' in serialized).toBe(false)
  })

  it('includes stack when the value has one', () => {
    const serialized = serializeErrorValue(new Error('boom'))

    expect('stack' in serialized).toBe(true)
    expect(serialized['stack']).toEqual(expect.any(String))
  })

  it('includes cause when the value has one', () => {
    const serialized = serializeErrorValue(new Error('outer', { cause: new Error('inner') }))

    expect('cause' in serialized).toBe(true)
  })

  it('includes errors for an AggregateError', () => {
    const serialized = serializeErrorValue(new AggregateError([new Error('a')], 'both'))

    expect('errors' in serialized).toBe(true)
  })
})

describe('withSemconvException (direct)', () => {
  /** A record shaped like one reaching `formatters.log`. */
  const recordWith = (err: unknown): Record<string, unknown> => ({ logKey: 'K_A_B', err })

  it('adds nothing under the pino format', () => {
    const out = withSemconvException(recordWith(new Error('boom')), 'pino')

    expect('exception.type' in out).toBe(false)
    expect('error.type' in out).toBe(false)
  })

  it(/*
   * A field the value cannot support must be ABSENT, not written as `undefined`:
   * the spec requires at least one of `exception.type` / `exception.message`, and
   * a key holding `undefined` satisfies neither while looking like it does.
   */
  'writes only the attributes the value supports', () => {
    const out = withSemconvException(recordWith({ name: 'PartialError' }), 'both')

    expect(out['exception.type']).toBe('PartialError')
    expect(out['error.type']).toBe('PartialError')
    expect('exception.message' in out).toBe(false)
    expect('exception.stacktrace' in out).toBe(false)
  })

  it.each([['a string'], [42], [null], [undefined]])(
    /*
     * A `null` or primitive `err` yields `undefined` for every field and must add
     * nothing — the reason the explicit type guard was removed: no input could
     * distinguish its presence.
     */
    'adds nothing for a non-object err (%p)',
    (err) => {
      const out = withSemconvException(recordWith(err), 'both')

      expect('exception.type' in out).toBe(false)
      expect('error.type' in out).toBe(false)
      expect(out['logKey']).toBe('K_A_B')
    }
  )

  it('drops the legacy err object only under the semconv format', () => {
    const withErr = withSemconvException(recordWith(new Error('boom')), 'both')
    const withoutErr = withSemconvException(recordWith(new Error('boom')), 'semconv')

    expect('err' in withErr).toBe(true)
    expect('err' in withoutErr).toBe(false)
    expect(withoutErr['logKey']).toBe('K_A_B')
  })
})

describe('withEventName (direct)', () => {
  it('writes nothing when disabled', () => {
    const out = withEventName({ logKey: 'PAYMENT_FAILED' }, false)

    expect('event.name' in out).toBe(false)
  })

  it.each([[''], [42], [undefined], [null]])(
    'writes nothing for a non-string or empty log key (%p)',
    (logKey) => {
      const out = withEventName({ logKey }, 'event.name')

      expect('event.name' in out).toBe(false)
    }
  )
})

describe('exception.stacktrace scrubbing', () => {
  it(/*
   * The semconv attribute must carry the SAME scrubbed stack as the legacy
   * `err.stack`. Emitting one scrubbed and one raw would mean a consumer moving
   * to `errorFormat: 'semconv'` silently started seeing the dependency frames the
   * shape they migrated from had filtered out.
   */
  'strips node_modules frames from exception.stacktrace', () => {
    const error = new Error('boom')
    error.stack = [
      'Error: boom',
      '    at app (/srv/app/src/service.ts:1:1)',
      '    at dep (/srv/app/node_modules/pkg/index.js:2:2)'
    ].join('\n')

    const out = withSemconvException({ logKey: 'K_A_B', err: error }, 'both')

    expect(out['exception.stacktrace']).toContain('/srv/app/src/service.ts')
    expect(out['exception.stacktrace']).not.toContain('node_modules')
  })
})

describe('err serializer — non-object thrown values', () => {
  it.each<[unknown, string]>([
    ['thrown string', 'a string spreads its characters'],
    [[1, 2, 3], 'an array spreads its elements'],
    [42, 'a number'],
    [null, 'null']
  ])(
    /*
     * REGRESSION — the own-property copy ran on ANY value, and `Object.entries`
     * on a thrown STRING spreads its characters as indexed keys: a real record
     * carried `"0":"t","1":"h",…` beside the UnknownError envelope. Same for an
     * array's elements. The envelope's stringified message already carries the
     * whole value, so the copy adds only unqueryable noise and payload bloat.
     */
    'emits only the envelope for %p (%s)',
    (thrown) => {
      const serialized = serializeErrorValue(thrown)

      expect(Object.keys(serialized).sort()).toEqual(['message', 'type'])
      expect(serialized['type']).toBe('UnknownError')
      expect(serialized).not.toHaveProperty('0')
    }
  )
})
