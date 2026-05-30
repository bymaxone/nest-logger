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
})
