/**
 * Verifies that a value whose prototype chain never ends cannot hang a log call: the walk that looks for
 * a `toJSON` has a bound, and a value past it is redacted whole. A loop cannot be timed out from inside
 * the process it blocks, so each case runs in a child with a deadline.
 *
 * Layer: server, tests. One child process per case; the redactor is the real one.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const TSX = join(__dirname, '../../node_modules/.bin/tsx')
const MODULE = join(__dirname, 'utils/redact-by-name.util.ts')

/** Runs `body` in a child that has the redactor as `redact`, and answers what it printed. */
function inChild(body: string): { out: string; timedOut: boolean } {
  const script = `import { createNameRedactor } from ${JSON.stringify(MODULE)}
const redact = createNameRedactor(['password'], '[REDACTED]')
${body}`
  const result = spawnSync(TSX, ['--eval', script], { encoding: 'utf8', timeout: 20_000 })
  return { out: String(result.stdout), timedOut: result.error !== undefined }
}

describe('a prototype chain that never ends', () => {
  /**
   * Given a Proxy whose getPrototypeOf trap answers a cycle of two Proxies
   * When a log payload that holds it is redacted
   * Then the call returns, and the value is the censor
   */
  it('is redacted whole instead of hanging the call', () => {
    const { out, timedOut } = inChild(`
const a: object = new Proxy({}, { getPrototypeOf: () => b })
const b: object = new Proxy({}, { getPrototypeOf: () => a })
console.log(JSON.stringify(redact({ hostile: a, password: 'x' })))`)

    expect(timedOut).toBe(false)
    expect(out.trim()).toBe('{"hostile":"[REDACTED]","password":"[REDACTED]"}')
  })

  /**
   * Given a Proxy whose getPrototypeOf trap answers a plain object that has a toJSON
   * When a log payload that holds it is redacted
   * Then the chain is walked as before and the method is honoured
   */
  it('walks a short chain as before', () => {
    const { out, timedOut } = inChild(`
const proto = { toJSON: () => ({ ok: true }) }
const value = new Proxy({}, { getPrototypeOf: () => proto })
console.log(JSON.stringify(redact({ value })))`)

    expect(timedOut).toBe(false)
    expect(out.trim()).toBe('{"value":{"ok":true}}')
  })
})
