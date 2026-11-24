/**
 * Verifies that the metadata of the service is read as what the consumer gave: a `name` or a `version`
 * planted on `Object.prototype` is no value of it, so the options are refused as when they are missing.
 *
 * Layer: server/config, tests.
 */
import { resolveOptions } from './resolve-options'

describe('service metadata with name and version planted on Object.prototype', () => {
  /**
   * Given `name` and `version` planted on `Object.prototype` and a service that sets neither
   * When the options are resolved
   * Then they are refused, not resolved to a service with no name
   */
  it('does not satisfy the check for a service that sets neither', () => {
    Object.defineProperty(Object.prototype, 'name', { configurable: true, value: 'evil' })
    Object.defineProperty(Object.prototype, 'version', { configurable: true, value: '9.9.9' })
    try {
      expect(() => resolveOptions({ service: {} } as never)).toThrow('service.name')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'name')
      Reflect.deleteProperty(Object.prototype, 'version')
    }
  })

  /**
   * Given the same keys planted and a service that sets its own
   * When the options are resolved
   * Then the service keeps its own values
   */
  it('keeps the values the service sets itself', () => {
    Object.defineProperty(Object.prototype, 'name', { configurable: true, value: 'evil' })
    try {
      expect(resolveOptions({ service: { name: 'app', version: '1.0.0' } }).service).toMatchObject({
        name: 'app',
        version: '1.0.0'
      })
    } finally {
      Reflect.deleteProperty(Object.prototype, 'name')
    }
  })
})
