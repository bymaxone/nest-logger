/**
 * Verifies that a value whose prototype chain never ends cannot hang a log call: the walk that looks for
 * a `toJSON` has a bound, and a value past it is redacted whole. A trap that counts its calls and throws
 * past a ceiling turns an unbounded walk into a failure the test can see, in process.
 *
 * Layer: server, tests. In process; the redactor is the real one.
 */
import { createNameRedactor } from './utils/redact-by-name.util'

/** Far more calls than one redaction of a bounded chain makes, and few enough for an endless walk to reach it at once. */
const CEILING = 1_000_000

/** A pair of Proxies whose prototype answers each other, and the count of the calls made on them. */
function cycle(): { held: object; calls: () => number } {
  let calls = 0
  const step = (next: () => object) => (): object => {
    if (++calls > CEILING) throw new Error('the walk did not stop')
    return next()
  }
  const first: object = new Proxy({}, { getPrototypeOf: step(() => second) })
  const second: object = new Proxy({}, { getPrototypeOf: step(() => first) })
  return { held: first, calls: () => calls }
}

describe('a prototype chain that never ends', () => {
  /**
   * Given a Proxy whose getPrototypeOf trap answers a cycle of two Proxies
   * When a log payload that holds it is redacted
   * Then the call returns before the ceiling, and the value is the censor
   */
  it('is redacted whole instead of hanging the call', () => {
    const { held, calls } = cycle()
    const redact = createNameRedactor(['password'], '[REDACTED]')

    const result = redact({ hostile: held, password: 'x' })

    expect(result).toEqual({ hostile: '[REDACTED]', password: '[REDACTED]' })
    expect(calls()).toBeLessThan(CEILING)
  })

  /**
   * Given a Proxy whose getPrototypeOf trap answers a plain object that has a toJSON
   * When a log payload that holds it is redacted
   * Then the method of that prototype is honoured
   */
  it('honours the toJSON of a short Proxy-provided chain', () => {
    const proto = { toJSON: () => ({ ok: true }) }
    const value = new Proxy({}, { getPrototypeOf: () => proto })
    const redact = createNameRedactor(['password'], '[REDACTED]')

    expect(JSON.stringify(redact({ value }))).toBe('{"value":{"ok":true}}')
  })
})
