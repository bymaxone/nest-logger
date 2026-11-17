/**
 * Verifies dropUnsetOptions: a key that holds `undefined` or `null` is dropped in the options and in
 * each group, a key that holds a falsy value that IS set (`false`, `0`, an empty string) is kept, a
 * value is read from each known key by property access, a key the options do not know is dropped, a
 * group that is not an object is left for the validator, and the input is not changed.
 *
 * Layer: server/config, tests.
 */
import { dropUnsetOptions } from './drop-unset-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

const SERVICE = { name: 'app', version: '1.0.0' }
const as = (value: unknown): BymaxLoggerModuleOptions => value as BymaxLoggerModuleOptions

describe('dropUnsetOptions', () => {
  it.each([
    ['a string', 'options'],
    ['null', null],
    ['an array', []],
    ['undefined', undefined]
  ])('returns %s as it is, for the validator to refuse', (_label, value) => {
    expect(dropUnsetOptions(as(value))).toBe(value)
  })

  it('drops the keys that hold undefined or null in the options and in each group', () => {
    const out = dropUnsetOptions(
      as({
        service: SERVICE,
        level: undefined,
        isGlobal: null,
        http: { isEnabled: true, tenantIdHeader: undefined, tenantIdResolver: null },
        otel: { fieldFormat: null },
        shutdown: { timeoutMs: undefined },
        destinationQueue: { maxBytes: null }
      })
    )

    expect(out).toEqual({
      service: SERVICE,
      http: { isEnabled: true },
      otel: {},
      shutdown: {},
      destinationQueue: {}
    })
  })

  /*
   * "Not set" is `undefined` and `null` and nothing else: a switch turned off, a size of zero and an
   * empty string are values the consumer chose, and the validator judges them.
   */
  it('keeps a falsy value that is set', () => {
    const out = dropUnsetOptions(
      as({
        service: SERVICE,
        isGlobal: false,
        maxEntrySizeBytes: 0,
        redactCensor: '',
        eventNameField: false,
        http: { isEnabled: false, tenantIdHeader: false },
        destinationQueue: { maxBytes: 0 }
      })
    )

    expect(out).toEqual({
      service: SERVICE,
      isGlobal: false,
      maxEntrySizeBytes: 0,
      redactCensor: '',
      eventNameField: false,
      http: { isEnabled: false, tenantIdHeader: false },
      destinationQueue: { maxBytes: 0 }
    })
  })

  it('reads each known key by property access, so a getter of a prototype counts', () => {
    class Shutdown {
      get timeoutMs(): number {
        return 5000
      }
    }

    const out = dropUnsetOptions(as({ service: SERVICE, shutdown: new Shutdown() }))

    expect(out).toEqual({ service: SERVICE, shutdown: { timeoutMs: 5000 } })
  })

  it('drops a key that the options do not know', () => {
    const out = dropUnsetOptions(as({ service: SERVICE, leveI: 'warn', http: { isEnable: true } }))

    expect(out).toEqual({ service: SERVICE, http: {} })
  })

  it('leaves a group that is not an object for the validator', () => {
    const out = dropUnsetOptions(as({ service: SERVICE, http: 'on', otel: [] }))

    expect(out).toEqual({ service: SERVICE, http: 'on', otel: [] })
  })

  it('returns a new object and does not change the one it was given', () => {
    const given = { service: SERVICE, level: undefined, http: { isEnabled: undefined } }

    const out = dropUnsetOptions(as(given))

    expect(out).not.toBe(given)
    expect(given).toEqual({ service: SERVICE, level: undefined, http: { isEnabled: undefined } })
    expect(Object.keys(given.http)).toEqual(['isEnabled'])
  })
})
