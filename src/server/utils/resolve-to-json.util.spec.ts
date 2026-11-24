/**
 * Verifies the bound of the walk that looks for a `toJSON` along a prototype chain: a chain that is long
 * but ends is read as it is, and one past the bound is reported as hostile instead of walked.
 *
 * Layer: server/utils, tests. In process: the chains here are finite, so nothing can hang.
 */
import { createNameRedactor } from './redact-by-name.util'
import { resolveToJson } from './resolve-to-json.util'

/** An object that sits at the head of a chain of `length` objects, the last of which has no prototype. */
function chainOf(length: number, tail: object = Object.create(null) as object): object {
  let head = tail
  for (let at = 1; at < length; at++) head = Object.create(head) as object
  return head
}

describe('resolveToJson along a long prototype chain', () => {
  /**
   * Given a chain of 257 objects, the longest the bound allows, with a toJSON at the end
   * When it is resolved
   * Then the method is found and the value is not hostile
   */
  it('finds a toJSON at the end of the longest chain allowed', () => {
    const toJSON = (): string => 'ok'
    const tail = Object.create(null) as object
    Object.defineProperty(tail, 'toJSON', { value: toJSON })

    const resolved = resolveToJson(chainOf(257, tail))

    expect(resolved.hostile).toBeFalsy()
    expect(resolved.method).toBe(toJSON)
  })

  /**
   * Given a chain of 258 objects, one past the bound
   * When it is resolved
   * Then it is reported as hostile and volatile, with no method
   */
  it('reports a chain one past the bound as hostile', () => {
    expect(resolveToJson(chainOf(258))).toEqual({
      method: undefined,
      volatile: true,
      hostile: true
    })
  })

  /**
   * Given a payload that holds a chain past the bound
   * When the payload is redacted by name
   * Then the value is the censor, and a chain within the bound is left as it is
   */
  it('redacts a value that holds a chain past the bound whole', () => {
    const redact = createNameRedactor(['password'], '[REDACTED]')

    const past = redact({ held: chainOf(258) }) as { held: unknown }
    const within = redact({ held: chainOf(257) }) as { held: unknown }

    expect(past.held).toBe('[REDACTED]')
    expect(within.held).not.toBe('[REDACTED]')
  })
})
