/**
 * Pins how the options of the module are read: a refusal of the library passes through once, and
 * anything else that goes wrong while the options are read, a getter or a Proxy of the host that
 * throws, is refused with a library message that keeps the host's error as its cause.
 *
 * Layer: server/config, tests. Pure.
 */
import { guardOptions, refuse } from './options-refusal.util'

const MESSAGE = '[BymaxLoggerModule] options could not be read'

describe('refuse', () => {
  it('throws an Error with the message given', () => {
    expect(() => refuse('[BymaxLoggerModule] options.level must be a level')).toThrow(
      '[BymaxLoggerModule] options.level must be a level'
    )
  })
})

describe('guardOptions', () => {
  it('returns what the read returns', () => {
    expect(guardOptions(() => 42)).toBe(42)
  })

  it('lets a refusal of the library through as it is, once', () => {
    let refusal: unknown
    try {
      refuse('[BymaxLoggerModule] options.x is wrong')
    } catch (error) {
      refusal = error
    }

    expect(() =>
      guardOptions(() => {
        throw refusal
      })
    ).toThrow('[BymaxLoggerModule] options.x is wrong')
    // Thrown again by the host, the same object is no longer the library's own.
    expect(() =>
      guardOptions(() => {
        throw refusal
      })
    ).toThrow(MESSAGE)
  })

  it('is used once and does not nest: a refusal passed on by an inner guard is read again by an outer one', () => {
    expect(() =>
      guardOptions(() =>
        guardOptions(() => {
          refuse('[BymaxLoggerModule] options.x is wrong')
        })
      )
    ).toThrow(MESSAGE)
  })

  it.each([
    ['an Error', new Error('host')],
    ['a string', 'host'],
    ['undefined', undefined],
    ['an Error made like a refusal', new Error('[BymaxLoggerModule] options.x is wrong')]
  ])('refuses %s thrown by the host, with it as the cause', (_label, thrown) => {
    let caught: unknown
    try {
      guardOptions(() => {
        throw thrown
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(MESSAGE)
    expect((caught as Error).cause).toBe(thrown)
  })

  it('does not run a trap of a Proxy thrown by the host to decide', () => {
    const thrown = new Proxy(new Error('host'), {
      getPrototypeOf(): never {
        throw new Error('trap')
      }
    })

    expect(() =>
      guardOptions(() => {
        throw thrown
      })
    ).toThrow(MESSAGE)
  })
})
