/**
 * Pins `buildPinoInstance` (the fan-out to destinations, redaction, formatting) and `leafNameOf`.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
import { leafNameOf } from './pino-factory'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { buildPinoInstance, createCapture, baseOptions } from './__tests__/pino-factory.fixtures'

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
   * A custom `timestamp` is interpolated into the JSON line by Pino's contract
   * (`,"time":<value>`), so a returned quote, backslash or newline would break
   * the line, and a crafted value would add fields to it. Each value below must
   * come out as the `time` string, byte for byte, and nothing else.
   */
  'JSON-escapes a custom timestamp so it cannot break or inject into the line', () => {
    const hostile = ['a"b', 'line1\nline2', 'back\\slash', '","injected":"yes', '\u2028']
    for (const raw of hostile) {
      const capture = createCapture()
      const logger = buildPinoInstance(
        applyDefaults({ ...baseOptions, timestamp: () => raw }),
        new LogContextService(),
        [capture.destination]
      )
      logger.info('hello')
      const [entry] = capture.entries()
      expect(entry?.['time']).toBe(raw)
      expect(entry).not.toHaveProperty('injected')
    }
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
   * REGRESSION — a destination whose `minLevel` is a throwing getter must not stop
   * the logger from being built. This read happens at provider-construction time,
   * BEFORE any lifecycle hook, so an escape here fails the factory and the
   * application never starts — earlier than any fail-soft path can contain it, and
   * therefore not covered by the guard in the registry's `effectiveLevelOf`.
   *
   * Unreadable is treated as absent: the destination falls back to the module
   * level, which is what a destination without a `minLevel` receives anyway.
   * Asserted on the sink still RECEIVING at the module level, not merely on the
   * absence of a throw.
   */
  'builds the logger when a destination minLevel getter throws', () => {
    const capture = createCapture('hostile')
    const hostile = { ...capture.destination }
    Object.defineProperty(hostile, 'minLevel', {
      get() {
        throw new Error('minLevel getter exploded')
      }
    })

    const logger = buildPinoInstance(
      applyDefaults({ ...baseOptions, level: 'info' }),
      new LogContextService(),
      [hostile]
    )
    logger.info({ logKey: 'INFO_EVT' }, 'info-msg')

    expect(capture.entries().map((entry) => entry['msg'])).toEqual(['info-msg'])
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
