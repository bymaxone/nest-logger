import { applyDefaults } from './config/default-options'
import { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
import type { ILogDestination } from './interfaces/log-destination.interface'
import {
  buildPinoInstance,
  leafNameOf,
  resolveNameRedactor,
  resolveRedactOption
} from './pino-factory'
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
    ['a..b', 'b']
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

  it.each([['*'], ['*.*'], ['.'], ['']])(
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
