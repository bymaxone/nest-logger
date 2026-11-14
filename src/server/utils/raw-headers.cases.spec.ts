/**
 * Covers censoring of the flat [name, value, ...] header arrays under rawHeaders: default names
 * under the names and paths strategies, a host-added name with the defaults disabled, a request
 * held by an Error, an object inside the array, and the rawTrailers key.
 * Layer: server/utils, tests.
 */
import { applyDefaults } from '../config/default-options'
import { baseOptions } from '../__tests__/pino-factory.fixtures'
import { resolveNameRedactor } from '../pino-factory'

const RAW = ['Authorization', 'LEAK-A', 'Accept', 'kept', 'X-Csrf-Token', 'LEAK-S']

/** The value of `rawHeaders` after the redactor the options resolve to has run over a record. */
function redactedRaw(
  options: Partial<Parameters<typeof applyDefaults>[0]>,
  record: (raw: string[]) => unknown,
  read: (out: unknown) => unknown
): unknown {
  return read(resolveNameRedactor(applyDefaults({ ...baseOptions, ...options }))(record([...RAW])))
}

const pick = (key: string) => (out: unknown) =>
  (out as { request: Record<string, unknown> }).request[key]

describe('rawHeaders censoring, by configuration', () => {
  it('censors the default names under the default names strategy', () => {
    expect(
      redactedRaw({}, (raw) => ({ request: { rawHeaders: raw } }), pick('rawHeaders'))
    ).toEqual(['Authorization', '[REDACTED]', 'Accept', 'kept', 'X-Csrf-Token', '[REDACTED]'])
  })

  it('censors the default names under the legacy paths strategy', () => {
    expect(
      redactedRaw(
        { redactStrategy: 'paths' },
        (raw) => ({ request: { rawHeaders: raw } }),
        pick('rawHeaders')
      )
    ).toEqual(['Authorization', '[REDACTED]', 'Accept', 'kept', 'X-Csrf-Token', '[REDACTED]'])
  })

  it('censors a name the host added, and only it, when the defaults are disabled', () => {
    expect(
      redactedRaw(
        { shouldDisableDefaultRedact: true, redactPaths: ['accept'] },
        (raw) => ({ request: { rawHeaders: raw } }),
        pick('rawHeaders')
      )
    ).toEqual(['Authorization', 'LEAK-A', 'Accept', '[REDACTED]', 'X-Csrf-Token', 'LEAK-S'])
  })

  it('reads the key whatever its case, and rawTrailers as well', () => {
    const out = redactedRaw(
      {},
      (raw) => ({ request: { RAWHEADERS: raw, rawTrailers: raw } }),
      (value) => value
    ) as { request: Record<string, unknown[]> }

    expect(out.request['RAWHEADERS']?.[1]).toBe('[REDACTED]')
    expect(out.request['rawTrailers']?.[1]).toBe('[REDACTED]')
  })

  it('censors a request held by an Error, which the walk converts to data', () => {
    const error = new Error('boom') as Error & { request?: unknown }
    error.request = { rawHeaders: [...RAW] }

    const out = redactedRaw(
      {},
      () => ({ request: error }),
      (value) => value
    ) as {
      request: { request: { rawHeaders: string[] } }
    }

    expect(out.request.request.rawHeaders[1]).toBe('[REDACTED]')
  })

  it('writes the values at even indexes and the names themselves as they are', () => {
    const out = redactedRaw(
      {},
      () => ({ request: { rawHeaders: ['LEAK-N', 'Authorization'] } }),
      pick('rawHeaders')
    )

    expect(out).toEqual(['LEAK-N', 'Authorization'])
  })

  it('censors a name the host protects by path, under the paths strategy, with the defaults on', () => {
    expect(
      redactedRaw(
        { redactStrategy: 'paths', redactPaths: ['headers.x-custom-token'] },
        () => ({
          request: { rawHeaders: ['X-Custom-Token', 'LEAK-H', 'Authorization', 'LEAK-A'] }
        }),
        pick('rawHeaders')
      )
    ).toEqual(['X-Custom-Token', '[REDACTED]', 'Authorization', '[REDACTED]'])
  })

  it('censors only the host name under the paths strategy with the defaults disabled', () => {
    expect(
      redactedRaw(
        {
          redactStrategy: 'paths',
          shouldDisableDefaultRedact: true,
          redactPaths: ['req.headers.x-custom-token']
        },
        () => ({
          request: { rawHeaders: ['X-Custom-Token', 'LEAK-H', 'Authorization', 'LEAK-A'] }
        }),
        pick('rawHeaders')
      )
    ).toEqual(['X-Custom-Token', '[REDACTED]', 'Authorization', 'LEAK-A'])
  })

  it('walks an object inside the array, so no value skips the redaction by key', () => {
    const out = redactedRaw(
      {},
      () => ({
        request: {
          rawHeaders: ['x', { password: 'LEAK-OBJ' }]
        }
      }),
      pick('rawHeaders')
    ) as unknown[]

    expect(out[1]).toEqual({ password: '[REDACTED]' })
  })
})
