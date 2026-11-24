/**
 * Verifies that a planted option is told from an accessor by an own `get` only: a data property of a root
 * is no accessor, even when `Object.prototype` carries a `get` that its descriptor would inherit.
 *
 * Layer: server/config, tests. In process; the filter is the real one.
 */
import { dropUnsetOptions } from './drop-unset-options'

describe('a planted option whose descriptor has no own get', () => {
  /**
   * Given `level` planted as data on Object.prototype, a function planted as `get` there too, and options
   * that are a Proxy answering another `level`
   * When they are filtered
   * Then the answer of the Proxy is kept and the options are not refused as an accessor
   */
  it('is not taken for an accessor through an inherited get', () => {
    const options = new Proxy(
      {},
      { get: (_target, key) => (key === 'level' ? 'debug' : undefined) }
    )
    Object.defineProperty(Object.prototype, 'level', {
      value: 'warn',
      configurable: true,
      writable: true
    })
    Object.defineProperty(Object.prototype, 'get', {
      value: () => 'forged',
      configurable: true,
      writable: true
    })

    try {
      expect(dropUnsetOptions(options as never)).toEqual({ level: 'debug' })
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get')
      Reflect.deleteProperty(Object.prototype, 'level')
    }
  })
})
