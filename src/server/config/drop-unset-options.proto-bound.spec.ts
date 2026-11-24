/**
 * Verifies that options whose prototype chain never ends cannot hang the boot: the walk that looks for a
 * planted root has a bound, and options past it are refused. A trap that counts its calls and throws past
 * a ceiling turns an unbounded walk into a failure the test can see, in process.
 *
 * Layer: server/config, tests. In process; the filter is the real one.
 */
import { dropUnsetOptions } from './drop-unset-options'

/** Far more calls than the bound allows, and few enough for an endless walk to reach it at once. */
const CEILING = 100_000

describe('options whose prototype chain never ends', () => {
  /**
   * Given options that are a Proxy whose getPrototypeOf trap answers a cycle of two Proxies
   * When they are filtered
   * Then the call is refused before the ceiling, with an error that names the bound
   */
  it('are refused instead of hanging the boot', () => {
    let calls = 0
    const step = (next: () => object) => (): object => {
      if (++calls > CEILING) throw new Error('the walk did not stop')
      return next()
    }
    const first: object = new Proxy({}, { getPrototypeOf: step(() => second) })
    const second: object = new Proxy({}, { getPrototypeOf: step(() => first) })

    expect(() => dropUnsetOptions(first as never)).toThrow(/holds more than 256 prototypes/)
    expect(calls).toBeLessThan(CEILING)
  })

  /**
   * Given options whose prototype is a short chain that holds a plain default
   * When they are filtered
   * Then the default of the chain is read
   */
  it('reads a short chain', () => {
    const options = Object.create(Object.create({ level: 'warn' })) as object

    expect(dropUnsetOptions(options as never)).toEqual({ level: 'warn' })
  })

  /**
   * Given options that sit at the head of a chain of 257 objects, the longest the bound allows, and one of 258
   * When each is filtered
   * Then the first is read and the second is refused
   */
  it('allows 257 objects in a chain and refuses 258', () => {
    const chain = (length: number): object => {
      let head = Object.create(null) as object
      for (let at = 1; at < length; at++) head = Object.create(head) as object
      return head
    }

    expect(dropUnsetOptions(chain(257) as never)).toEqual({})
    expect(() => dropUnsetOptions(chain(258) as never)).toThrow(/holds more than 256 prototypes/)
  })
})
