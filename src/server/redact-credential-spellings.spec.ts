/**
 * Pins that the default redaction list censors the credential names real systems write, in each
 * spelling they use: the OAuth wire names (`access_token`, `refresh_token`, `id_token`), the
 * snake and kebab forms of the secrets the list already covered in camelCase, and the HTTP header
 * names that carry a session or a CSRF token. A name missing here was written in clear, as the
 * value of an ordinary metadata key. Driven through the real Pino pipeline under both strategies,
 * at the record root and nested, on the line a destination receives.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { REDACT_COMMON_FIELDS } from './constants/default-redact-paths.constants'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SPELLINGS = [
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'api_secret',
  'client_secret',
  'signing_secret',
  'private_key',
  'secret_key',
  'access-token',
  'refresh-token',
  'id-token',
  'api-key',
  'client-secret',
  'private-key',
  'proxy-authorization',
  'set-cookie',
  'cookie',
  'session_token',
  'sessionToken',
  'session-token',
  'sessiontoken',
  'x-csrf-token',
  'x-xsrf-token',
  'csrf_token',
  'csrfToken',
  'password_hash',
  'new_password',
  'old_password'
] as const

function written(
  extra: Partial<BymaxLoggerModuleOptions>,
  meta: Record<string, unknown>
): { line: string } {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  new PinoLoggerService(pino, resolveNameRedactor(options)).info('KEY', 'hello', 'u1', meta)
  return { line: lines.join('') }
}

describe.each([
  ['names', {}],
  ['paths', { redactStrategy: 'paths' as const }]
])('the default credential names, under the %s strategy', (_strategy, extra) => {
  it.each(SPELLINGS)('censors %s at the record root and one level down', (name) => {
    const { line } = written(extra, { [name]: 'LEAK-ROOT', nested: { [name]: 'LEAK-NESTED' } })

    expect(line).not.toContain('LEAK-ROOT')
    expect(line).not.toContain('LEAK-NESTED')
  })

  it('still writes sessionId, session_id and session-id, which are correlation keys', () => {
    const { line } = written(extra, {
      sessionId: 'sess-visible-1',
      nested: { session_id: 'sess-visible-2', 'session-id': 'sess-visible-3' }
    })

    expect(line).toContain('sess-visible-1')
    expect(line).toContain('sess-visible-2')
    expect(line).toContain('sess-visible-3')
  })

  it('still writes a name that is not a credential', () => {
    const { line } = written(extra, { orderId: 'o-visible', nested: { status: 'ok-visible' } })

    expect(line).toContain('o-visible')
    expect(line).toContain('ok-visible')
  })
})

describe('a host that adds its own credential name', () => {
  it('censors sessionId, at any depth, once the host adds it to its own redact list, under the default strategy', () => {
    const { line } = written(
      { redactPaths: ['sessionId'] },
      {
        sessionId: 'LEAK-S1',
        nested: {
          sessionId: 'LEAK-S2',
          deeper: { sessionId: 'LEAK-S3', deepest: { sessionId: 'LEAK-S4' } }
        }
      }
    )

    expect(line).not.toContain('LEAK-S1')
    expect(line).not.toContain('LEAK-S2')
    expect(line).not.toContain('LEAK-S3')
    expect(line).not.toContain('LEAK-S4')
  })
})

describe('the default name list', () => {
  it('lists each spelling under test, whatever its case', () => {
    const lower = new Set(REDACT_COMMON_FIELDS.map((name) => name.toLowerCase()))

    for (const name of SPELLINGS) {
      expect(lower.has(name.toLowerCase())).toBe(true)
    }
  })
})
