/**
 * Pins that a field of an error is read as own string data and as nothing else: an accessor `code` or
 * `name` is not data even when `Object.prototype` carries a `value`, which the descriptor of the
 * accessor would otherwise inherit.
 *
 * Layer: server/utils, tests. Pure.
 */
import { ownFieldForLog, OMIT_OWN_FIELD } from './sanitize-error.util'

/** Runs `body` with `value` planted on `Object.prototype`, and takes it off again. */
function withPlantedValue<T>(planted: string, body: () => T): T {
  Object.defineProperty(Object.prototype, 'value', {
    value: planted,
    configurable: true,
    writable: true
  })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, 'value')
  }
}

describe('ownFieldForLog reads own string data only', () => {
  /**
   * Given an error whose `code` is an accessor and a `value` of '23505' planted on Object.prototype
   * When a database value field of it is written
   * Then the field is kept, because an accessor is not a SQLSTATE the protocol sent
   */
  it('does not take an inherited value for the SQLSTATE of an accessor code', () => {
    const error = Object.defineProperty(new Error('failed'), 'code', {
      get: () => 'not read',
      enumerable: true
    })

    const written = withPlantedValue('23505', () => ownFieldForLog(error, 'detail', 'row 7'))

    expect(written).toBe('row 7')
  })

  /**
   * Given a command whose `name` is an accessor and a `value` planted on Object.prototype
   * When the command of an error is written
   * Then it is omitted, and the planted string is not the name of the command
   */
  it('does not take an inherited value for the name of an accessor name', () => {
    const command = Object.defineProperty({}, 'name', { get: () => 'not read', enumerable: true })

    const written = withPlantedValue('GET', () =>
      ownFieldForLog(new Error('failed'), 'command', command)
    )

    expect(written).toBe(OMIT_OWN_FIELD)
  })

  /**
   * Given an error with an own string `code` that is a SQLSTATE, and a command with an own string `name`
   * When their fields are written with nothing planted
   * Then the database field is omitted and the command keeps its name
   */
  it('still reads an own data code and an own data name', () => {
    const error = Object.assign(new Error('failed'), { code: '23505' })

    expect(ownFieldForLog(error, 'detail', 'row 7')).toBe(OMIT_OWN_FIELD)
    expect(ownFieldForLog(error, 'command', { name: 'GET', args: ['k'] })).toEqual({ name: 'GET' })
  })
})
