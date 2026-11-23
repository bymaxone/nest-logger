/**
 * Verifies that an accessor planted on `Object.prototype` is refused when the logger is built: Pino
 * merges its options with `Object.assign({}, …)`, where an inherited setter discards the value the
 * library set and an inherited getter supplies another in its place, such as a `formatters.log` that
 * returns the record as it is.
 *
 * Layer: server, tests. Driven through the real Pino.
 */
import { resolveOptions } from './config/resolve-options'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'

const SERVICE = { name: 'app', version: '1.0.0' }

/** Build a logger with `key` planted as an accessor on `Object.prototype`, and write one secret. */
function buildWith(
  key: string,
  descriptor: PropertyDescriptor | undefined
): { lines: string[]; threw: unknown } {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, key)
  if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
  const lines: string[] = []
  let threw: unknown
  try {
    const logger = buildPinoInstance(
      resolveOptions({ service: SERVICE }),
      new LogContextService(),
      [{ name: 'sink', write: (line: string) => lines.push(line) } as never],
      new DestinationHealth()
    )
    logger.info({ password: 'SECRET' }, 'probe')
  } catch (error) {
    threw = error
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
    if (before) Object.defineProperty(Object.prototype, key, before)
  }
  return { lines, threw }
}

describe('an accessor planted on Object.prototype when the logger is built', () => {
  const leaking = {
    configurable: true,
    get: () => ({ level: (label: string) => ({ level: label }), log: (record: object) => record }),
    set: () => undefined
  }

  /**
   * Given a setter and a getter planted under `formatters`, which hand Pino a formatter that keeps the record
   * When the logger is built and a secret is logged
   * Then the build is refused and nothing is written
   */
  it('is refused when it replaces the formatters, so no secret is written', () => {
    const { lines, threw } = buildWith('formatters', leaking)

    expect(threw).toBeInstanceOf(Error)
    expect((threw as Error).message).toContain('Object.prototype')
    expect(lines.join('')).not.toContain('SECRET')
  })

  /**
   * Given an accessor planted under a name the library sets, one it leaves unset and one Pino defaults
   * When the logger is built
   * Then each is refused, whether it has a getter, a setter or both, and whether it is enumerable or not
   */
  it.each([
    ['level', 'get'],
    ['redact', 'set'],
    ['transport', 'get'],
    ['messageKey', 'set'],
    ['log', 'get']
  ])('is refused under %s with a %s only', (key, side) => {
    const descriptor =
      side === 'get'
        ? { configurable: true, enumerable: false, get: () => undefined }
        : { configurable: true, enumerable: false, set: () => undefined }

    expect((buildWith(key, descriptor).threw as Error).message).toContain(key)
  })

  /**
   * Given nothing planted, and a plain data value planted under the same names
   * When the logger is built
   * Then it is built and the secret is redacted, since only an accessor can intercept the merge
   */
  it('builds as usual with no accessor planted, or with a data value planted', () => {
    const plain = buildWith('formatters', undefined)
    const data = buildWith('formatters', { configurable: true, value: {}, writable: true })

    for (const { lines, threw } of [plain, data]) {
      expect(threw).toBeUndefined()
      expect(lines.join('')).not.toContain('SECRET')
      expect(lines.join('')).toContain('[REDACTED]')
    }
  })
})
