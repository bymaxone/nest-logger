/**
 * Pins the family behind `redact-paths-writable.spec.ts`: under `redactStrategy: 'paths'` the name
 * walk's output reaches `@pinojs/redact`, which assigns its censor into it in strict mode, so no
 * own data property of any object in that output may be non-writable. The one stated exception is
 * the `toJSON` shadow of an `Error` clone, which is checked by name and by descriptor. The records
 * are drawn from a fixed seed, so a failure names a case that can be run again; a new kind of value
 * the walk can hold needs a new entry in `kinds()`.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { resolveNameRedactor } from './pino-factory'

const SEED = 20261109
const CASES = 1500
const SECRET = 'SECRET-VALUE'
const KEYS = ['cookie', 'authorization', 'token', 'password', 'a', 'b', 'err', 'meta', 'message']

/** A deterministic generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

type Pick = () => number

/** One value of a kind the walk can hold, nested up to `depth` further levels. */
function value(pick: Pick, depth: number): unknown {
  const draw = pick()
  if (depth <= 0 || draw < 0.15) return [SECRET, 7, true, null][Math.floor(pick() * 4)]
  const nested = (): unknown => value(pick, depth - 1)
  const fields = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (let index = 0; index < 1 + Math.floor(pick() * 3); index++) {
      out[KEYS[Math.floor(pick() * KEYS.length)] as string] = nested()
    }
    return out
  }
  if (draw < 0.45) return fields()
  if (draw < 0.55) return [nested(), nested()]
  if (draw < 0.65) return Buffer.from(SECRET)
  if (draw < 0.9) {
    const error = Object.assign(new Error(SECRET, { cause: nested() }), fields())
    return pick() < 0.4 ? Object.freeze(error) : error
  }
  if (draw < 0.95) return new AggregateError([nested(), nested()], SECRET)
  return new Map([['k', nested()]])
}

const configurations: [string, Partial<BymaxLoggerModuleOptions>][] = [
  ['paths, errorOwnFields all', { redactStrategy: 'paths' }],
  ['paths, errorOwnFields safe', { redactStrategy: 'paths', errorOwnFields: 'safe' }]
]

/** Every object reachable from `root` through own data properties, enumerable or not. */
function reachable(root: unknown): Set<object> {
  const seen = new Set<object>()
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return
    seen.add(node)
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key) as PropertyDescriptor
      if (descriptor.get === undefined && descriptor.set === undefined) visit(descriptor.value)
    }
  }
  visit(root)
  return seen
}

/**
 * The own data properties of the objects the walk built, those of `output` that are not an object
 * of `input`, that are not writable, and a non-enumerable `toJSON` that is not exactly the shadow
 * of an `Error` clone, which is the one property that is not writable.
 */
function nonWritable(input: unknown, output: unknown): string[] {
  const found: string[] = []
  const given = reachable(input)
  for (const node of reachable(output)) {
    if (given.has(node)) continue
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key) as PropertyDescriptor
      const data = descriptor.get === undefined && descriptor.set === undefined
      const shadow =
        key === 'toJSON' &&
        descriptor.value === undefined &&
        descriptor.enumerable === false &&
        descriptor.writable === false &&
        descriptor.configurable === true
      // A non-enumerable `toJSON` must be exactly the shadow; every other data property is writable.
      const hidden = key === 'toJSON' && descriptor.enumerable === false
      if (data && (hidden ? !shadow : descriptor.writable !== true)) found.push(String(key))
    }
  }
  return found
}

describe.each(configurations)('the output of the name walk, with %s', (_name, extra) => {
  it('holds no own data property that is not writable, but the toJSON shadow', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
    )
    const pick = random(SEED)
    const failures: string[] = []

    for (let index = 0; index < CASES; index++) {
      const record = { a: { b: value(pick, 4) }, cookie: value(pick, 3), meta: value(pick, 3) }
      const found = nonWritable(record, redact(record, true))
      if (found.length > 0) failures.push(`${index} ${found.slice(0, 3).join(' ')}`)
    }

    expect(failures).toEqual([])
  })
})
