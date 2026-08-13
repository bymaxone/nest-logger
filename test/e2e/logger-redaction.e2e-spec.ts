import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

/**
 * End-to-end coverage for PII / credential redaction — the library's
 * non-negotiable security invariant. These specs drive the REAL Pino redact
 * pipeline (compiled paths + censor) through the booted module and assert that
 * sensitive values never reach the serialized stdout entry.
 */
describe('Logger E2E — redaction', () => {
  let app: INestApplication | undefined
  let stdoutSpy: jest.SpyInstance

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  /**
   * Boot the module with the given overrides and return the resolved logger.
   * The stdout spy is installed BEFORE compile so the bootstrap entry is
   * captured alongside the probe entries the tests emit.
   */
  async function bootLogger(
    overrides: Partial<BymaxLoggerModuleOptions>
  ): Promise<PinoLoggerService> {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-redact', version: '0.0.0' },
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
   * By default, nested credentials (password, accessToken) and the conservative
   * `email` PII field must be replaced with the censor, while a non-sensitive
   * sibling (`name`) passes through untouched — proving DEFAULT_REDACT_PATHS is
   * wired end-to-end.
   */
  'redacts nested credentials and PII by default while keeping safe fields', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_PROBE', 'probe', undefined, {
      account: {
        password: 'super-secret',
        accessToken: 'tok-abc-123',
        email: 'alice@example.com',
        name: 'Alice'
      }
    })

    const account = findEntry('REDACT_PROBE')?.['account'] as Record<string, unknown>
    expect(account['password']).toBe('[REDACTED]')
    expect(account['accessToken']).toBe('[REDACTED]')
    expect(account['email']).toBe('[REDACTED]')
    expect(account['name']).toBe('Alice')
  })

  it(/*
   * The absolute header paths must scrub `req.headers.authorization` (a bearer
   * token) while leaving a harmless header (`accept`) intact — bracket/dot
   * absolute paths working through the real pipeline.
   */
  'redacts the authorization header by absolute path', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_HEADERS', 'probe', undefined, {
      req: { headers: { authorization: 'Bearer secret-token', accept: 'application/json' } }
    })

    const req = findEntry('REDACT_HEADERS')?.['req'] as { headers: Record<string, unknown> }
    expect(req.headers['authorization']).toBe('[REDACTED]')
    expect(req.headers['accept']).toBe('application/json')
  })

  it(/*
   * A consumer-supplied `redactPaths` entry must be MERGED with the defaults:
   * the custom `*.ssn` path is redacted AND a default field (`password`) in the
   * same object is still redacted.
   */
  'merges custom redactPaths with the defaults', async () => {
    const logger = await bootLogger({ redactPaths: ['*.ssn'] })

    logger.info('REDACT_CUSTOM', 'probe', undefined, {
      profile: { ssn: '123-45-6789', password: 'p' }
    })

    const profile = findEntry('REDACT_CUSTOM')?.['profile'] as Record<string, unknown>
    expect(profile['ssn']).toBe('[REDACTED]')
    expect(profile['password']).toBe('[REDACTED]')
  })

  it(/*
   * A custom `redactCensor` must replace the value instead of the default
   * `[REDACTED]` marker.
   */
  'honors a custom redactCensor', async () => {
    const logger = await bootLogger({ redactCensor: '***' })

    logger.info('REDACT_CENSOR', 'probe', undefined, { account: { password: 'p' } })

    const account = findEntry('REDACT_CENSOR')?.['account'] as Record<string, unknown>
    expect(account['password']).toBe('***')
  })

  it(/*
   * `shouldDisableDefaultRedact: true` opts out of the canonical protection —
   * the value leaks verbatim. This documents the danger AND proves the gate
   * actually controls the redact config end-to-end.
   */
  'leaks values when default redaction is explicitly disabled', async () => {
    const logger = await bootLogger({ shouldDisableDefaultRedact: true })

    logger.info('REDACT_DISABLED', 'probe', undefined, { account: { password: 'leaked' } })

    const account = findEntry('REDACT_DISABLED')?.['account'] as Record<string, unknown>
    expect(account['password']).toBe('leaked')
  })

  it(/*
   * REGRESSION — audit finding D-1. The README sold `LOGGER_BOOTSTRAP_WARNING`
   * as the audit trail proving when PII protection had been turned off ("so
   * security reviews can audit when PII protection was intentionally reduced").
   * The key was declared and never written, so a deployment running with
   * redaction disabled was indistinguishable from a protected one.
   */
  'emits LOGGER_BOOTSTRAP_WARNING when default redaction is disabled', async () => {
    await bootLogger({ shouldDisableDefaultRedact: true, redactPaths: ['*.password'] })

    const warning = findEntry('LOGGER_BOOTSTRAP_WARNING')
    expect(warning).toBeDefined()
    expect(warning?.['level']).toBe('warn')
    expect(warning?.['shouldDisableDefaultRedact']).toBe(true)
    expect(warning?.['redactPathCount']).toBe(1)
  })

  it(/*
   * The converse: a normally-configured module must NOT emit the warning, or the
   * signal would be noise and a security review would learn to ignore it.
   */
  'does not emit the bootstrap warning under the default configuration', async () => {
    await bootLogger({})

    expect(findEntry('LOGGER_BOOTSTRAP_WARNING')).toBeUndefined()
    expect(findEntry('LOGGER_BOOTSTRAP_OK')).toBeDefined()
  })

  it(/*
   * REGRESSION — audit finding S-1. `authorization` / `cookie` / `x-api-key` /
   * `set-cookie` were covered ONLY by the absolute paths `req.headers.*` /
   * `res.headers.*`. A headers bag logged under any other key — the most common
   * thing written while debugging an integration — put the bearer token in the
   * log in clear. This drives the real booted pipeline, not the util in isolation.
   */
  'redacts an auth header bag logged outside the req.headers shape', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_HEADER_BAG', 'probe', undefined, {
      headers: {
        authorization: 'Bearer LEAKED',
        cookie: 'sid=LEAKED',
        'x-api-key': 'LEAKED',
        'set-cookie': 'sid=LEAKED',
        'user-agent': 'curl/8'
      },
      authorization: 'Bearer LEAKED'
    })

    const entry = findEntry('REDACT_HEADER_BAG')
    const headers = entry?.['headers'] as Record<string, unknown>
    expect(headers['authorization']).toBe('[REDACTED]')
    expect(headers['cookie']).toBe('[REDACTED]')
    expect(headers['x-api-key']).toBe('[REDACTED]')
    expect(headers['set-cookie']).toBe('[REDACTED]')
    expect(headers['user-agent']).toBe('curl/8')
    expect(entry?.['authorization']).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — audit finding S-2. The wildcard path list reached four levels;
   * a secret nested deeper leaked silently. Depth 5 is the first level the old
   * engine could not reach, and 12 proves no lower ceiling replaced it.
   */
  'redacts secrets nested deeper than the old four-level ceiling', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_DEEP', 'probe', undefined, {
      l1: { l2: { l3: { l4: { l5: { password: 'LEAKED' } } } } },
      d1: { d2: { d3: { d4: { d5: { d6: { d7: { d8: { d9: { d10: { cpf: 'LEAKED' } } } } } } } } } }
    })

    expect(JSON.stringify(findEntry('REDACT_DEEP'))).not.toContain('LEAKED')
  })

  it(/*
   * A circular payload must neither hang the walk nor re-expose the raw values
   * through the cycle, and the entry must still be emitted.
   */
  'redacts a circular payload without leaking through the cycle', async () => {
    const logger = await bootLogger({})
    const node: Record<string, unknown> = { password: 'LEAKED' }
    node['self'] = node

    logger.info('REDACT_CIRCULAR', 'probe', undefined, { node })

    const entry = findEntry('REDACT_CIRCULAR')
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * An Error's own enumerable properties reach the sink through Pino's `err`
   * SERIALIZER, which runs AFTER `formatters.log` — so the name walk alone would
   * never see them. This pins the second redaction hook: the walk deliberately
   * skips Error instances (copying one would break the instance the serializer
   * keys off), and the serializer's OUTPUT is redacted instead. The serialized
   * `type` / `message` / `stack` must survive intact.
   */
  'redacts an own property carried on a logged Error', async () => {
    const logger = await bootLogger({})
    const error = Object.assign(new Error('boom'), { apiKey: 'LEAKED' })

    logger.info('REDACT_ERR', 'probe', undefined, { err: error })

    const entry = findEntry('REDACT_ERR')
    const err = entry?.['err'] as Record<string, unknown>
    expect(err['type']).toBe('Error')
    expect(err['message']).toBe('boom')
    expect(err['stack']).toContain('Error: boom')
    expect(err['apiKey']).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * The same serializer hook must apply to a CONSUMER-supplied serializer, not
   * just the built-in `err` one — otherwise a custom serializer would be a
   * documented way to route a secret around the default protection.
   */
  'redacts the output of a consumer-supplied serializer', async () => {
    const logger = await bootLogger({
      serializers: { account: (input) => ({ ...(input as object), seen: true }) }
    })

    logger.info('REDACT_SERIALIZER', 'probe', undefined, {
      account: { id: 'a1', password: 'LEAKED' }
    })

    const account = findEntry('REDACT_SERIALIZER')?.['account'] as Record<string, unknown>
    expect(account['seen']).toBe(true)
    expect(account['id']).toBe('a1')
    expect(account['password']).toBe('[REDACTED]')
  })

  it(/*
   * The serializer hook is LOAD-BEARING, not a second pass over data already
   * walked. A serializer PRODUCES a value: here the sensitive field exists
   * nowhere in the record `formatters.log` inspected, and is synthesized during
   * serialization. Only redacting the serializer's output can catch it — which
   * is why the composition cannot be simplified away as redundant.
   */
  'redacts a sensitive field a serializer synthesizes from nothing', async () => {
    const logger = await bootLogger({
      serializers: {
        session: (input) => ({
          id: (input as { id: string }).id,
          // Derived during serialization — absent from the logged record.
          accessToken: 'LEAKED-derived-at-serialize-time'
        })
      }
    })

    logger.info('REDACT_SYNTHESIZED', 'probe', undefined, { session: { id: 's1' } })

    const entry = findEntry('REDACT_SYNTHESIZED')
    const session = entry?.['session'] as Record<string, unknown>
    expect(session['id']).toBe('s1')
    expect(session['accessToken']).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — `PinoLoggerService.child(bindings)` is public API that accepts
   * any record, and Pino pre-serializes child bindings into the instance's
   * `chindings` fragment BEFORE `formatters.log` runs. The factory's hook can
   * therefore never see them, so `logger.child({ password })` stamped the value
   * in clear on every entry that child emitted. Redaction for bindings lives in
   * `child()` itself.
   */
  'redacts sensitive child-logger bindings', async () => {
    const logger = await bootLogger({})

    const child = logger.child({ password: 'LEAKED', tenantId: 't_1' })
    child.info('REDACT_CHILD', 'probe')

    const entry = findEntry('REDACT_CHILD')
    expect(entry?.['password']).toBe('[REDACTED]')
    // A non-sensitive binding is untouched — the fix must not scrub everything.
    expect(entry?.['tenantId']).toBe('t_1')
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — an `Error` under a key with no Pino serializer was skipped by
   * the walk and then JSON-serialized directly, so its own enumerable properties
   * reached the sink in clear. It must be censored, and the value must remain an
   * Error so the `err` serializer still recognises it where one applies.
   */
  'redacts an Error stored under a key that has no serializer', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_NESTED_ERR', 'probe', undefined, {
      failure: Object.assign(new Error('boom'), { apiKey: 'LEAKED' })
    })

    const failure = findEntry('REDACT_NESTED_ERR')?.['failure'] as Record<string, unknown>
    expect(failure['apiKey']).toBe('[REDACTED]')
    expect(JSON.stringify(findEntry('REDACT_NESTED_ERR'))).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — a value with `toJSON()` decides its own serialized form, so the
   * walk cannot inspect its own properties. Skipping it outright let the method
   * SYNTHESIZE a secret straight into the output. The walk now redacts what
   * `toJSON()` returns, while leaving a clean value (a `Date`) by reference.
   */
  'redacts a secret synthesized by toJSON without disturbing clean values', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_TOJSON', 'probe', undefined, {
      credential: { toJSON: (): unknown => ({ accessToken: 'LEAKED' }) },
      when: new Date('2020-01-01T00:00:00.000Z')
    })

    const entry = findEntry('REDACT_TOJSON')
    expect((entry?.['credential'] as Record<string, unknown>)['accessToken']).toBe('[REDACTED]')
    expect(entry?.['when']).toBe('2020-01-01T00:00:00.000Z')
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — HTTP header names are case-insensitive by spec, and only
   * INBOUND Node headers arrive lower-cased. A hand-built or outbound bag
   * routinely carries `Authorization` / `Cookie` / `X-API-Key`, and a
   * case-sensitive name set left every one of them in clear while the docs
   * claimed header coverage.
   */
  'redacts auth headers regardless of their casing', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_HEADER_CASE', 'probe', undefined, {
      headers: {
        Authorization: 'Bearer LEAKED',
        Cookie: 'sid=LEAKED',
        'X-API-Key': 'LEAKED',
        'Content-Type': 'application/json'
      }
    })

    const headers = findEntry('REDACT_HEADER_CASE')?.['headers'] as Record<string, unknown>
    expect(headers['Authorization']).toBe('[REDACTED]')
    expect(headers['Cookie']).toBe('[REDACTED]')
    expect(headers['X-API-Key']).toBe('[REDACTED]')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.stringify(findEntry('REDACT_HEADER_CASE'))).not.toContain('LEAKED')
  })

  it(/*
   * REGRESSION — `JSON.stringify` gives `toJSON` precedence over array
   * serialization. With the array branch running first, an array whose
   * `toJSON()` synthesized a secret was walked as an ordinary array — finding
   * nothing in its elements — and then emitted the secret at serialization time.
   */
  'redacts what an array with a custom toJSON synthesizes', async () => {
    const logger = await bootLogger({})

    logger.info('REDACT_ARRAY_TOJSON', 'probe', undefined, {
      list: Object.assign([], { toJSON: (): unknown => ({ accessToken: 'LEAKED' }) }),
      plain: [{ password: 'LEAKED' }]
    })

    const entry = findEntry('REDACT_ARRAY_TOJSON')
    expect((entry?.['list'] as Record<string, unknown>)['accessToken']).toBe('[REDACTED]')
    // An ordinary array must still serialize as an array.
    expect(Array.isArray(entry?.['plain'])).toBe(true)
    expect(JSON.stringify(entry)).not.toContain('LEAKED')
  })

  it(/*
   * `PinoLoggerService.child()` applies the DEFAULT-set redactor, which is the
   * identity under `redactStrategy: 'paths'`. Bindings stay covered there anyway
   * because that strategy configures `fast-redact` on the Pino instance, and Pino
   * runs it over child bindings as it builds them. That is a real coupling
   * between two independent mechanisms, so it is pinned here rather than assumed
   * — if either side changes, this fails instead of leaking silently.
   */
  'keeps child bindings covered under the legacy paths strategy', async () => {
    const logger = await bootLogger({ redactStrategy: 'paths' })

    logger.child({ password: 'LEAKED', tenantId: 't_1' }).info('REDACT_CHILD_PATHS', 'probe')

    const entry = findEntry('REDACT_CHILD_PATHS')
    expect(entry?.['password']).toBe('[REDACTED]')
    expect(entry?.['tenantId']).toBe('t_1')
  })

  it(/*
   * The legacy engine stays reachable behind `redactStrategy: 'paths'` for a
   * consumer depending on exact `fast-redact` path semantics — including its
   * four-level ceiling, which is asserted here so the escape hatch is documented
   * by a test rather than by a claim.
   */
  'keeps the legacy path engine reachable, four-level ceiling included', async () => {
    const logger = await bootLogger({ redactStrategy: 'paths' })

    logger.info('REDACT_LEGACY', 'probe', undefined, {
      shallow: { password: 'covered' },
      l1: { l2: { l3: { l4: { l5: { password: 'beyond-the-ceiling' } } } } }
    })

    const entry = findEntry('REDACT_LEGACY')
    expect((entry?.['shallow'] as Record<string, unknown>)['password']).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).toContain('beyond-the-ceiling')
  })
})
