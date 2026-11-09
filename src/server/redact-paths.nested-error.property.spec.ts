/**
 * Pins the family behind `redact-paths.nested-error.spec.ts`. Under `redactStrategy: 'paths'` an
 * `Error` anywhere in the record is converted with the default names censored in its own fields
 * and its cause chain at any depth, and data that is not an `Error` is matched only by the
 * configured paths. Records are drawn from a fixed seed, so a failure names a case that can be run
 * again: `Error`s at the top, nested, inside lists and chained through up to six causes, with own
 * fields named from the default set; and, beside them, data under a default name placed beyond
 * what the default paths reach, which must stay in clear unless a configured path names it.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { REDACT_COMMON_FIELDS } from './constants/default-redact-paths.constants'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { DEFAULT_MAX_CAUSE_DEPTH } from './utils/sanitize-error.util'

const SEED = 20261110
const CASES = 400
const MAX_CHAIN = 6

/** A deterministic generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

interface Drawn {
  readonly record: Record<string, unknown>
  /** The message of each link within the depth the chain is written to: the proof of conversion. */
  readonly messages: string[]
  /** The values under a default name in an `Error`, which must not appear. */
  readonly secrets: string[]
  /** The value kept in clear beyond the default paths, and the path of the consumer naming it. */
  readonly plain: { readonly value: string; readonly path: string }
}

/** One `Error` with a chain of causes, own fields drawn from the default names. */
function drawError(pick: () => number, id: number, secrets: string[], messages: string[]): Error {
  const links = 1 + Math.floor(pick() * MAX_CHAIN)
  let cause: Error | undefined
  for (let link = links; link >= 1; link--) {
    const message = `message-${id}-${link}`
    if (link <= DEFAULT_MAX_CAUSE_DEPTH) messages.push(message)
    const error = new Error(message, cause === undefined ? undefined : { cause })
    const fields = 1 + Math.floor(pick() * 3)
    for (let index = 0; index < fields; index++) {
      const name = REDACT_COMMON_FIELDS[Math.floor(pick() * REDACT_COMMON_FIELDS.length)] as string
      const secret = `SECRET-${id}-${link}-${index}`
      secrets.push(secret)
      Reflect.set(error, name, pick() < 0.3 ? { headers: { [name]: secret }, note: 'ok' } : secret)
    }
    cause = error
  }
  return cause as Error
}

/** A record holding Errors at random places, and data under a default name out of the default reach. */
function draw(pick: () => number, id: number): Drawn {
  const secrets: string[] = []
  const messages: string[] = []
  const errors = Array.from({ length: 1 + Math.floor(pick() * 3) }, (_, n) =>
    drawError(pick, id * 10 + n, secrets, messages)
  )
  const record: Record<string, unknown> = {}
  errors.forEach((error, n) => {
    const place = pick()
    if (place < 0.25) record[`top${n}`] = error
    else if (place < 0.5) record[`list${n}`] = [1, error]
    else {
      const depth = 1 + Math.floor(pick() * 7)
      let inner: unknown = { error }
      for (let level = 0; level < depth; level++) inner = { [`k${level}`]: inner }
      record[`nest${n}`] = inner
    }
  })
  const depth = 6 + Math.floor(pick() * 3)
  const keys = Array.from({ length: depth }, (_, level) => `p${level}`)
  const value = `KEEP-${id}`
  let leaf: unknown = { password: value }
  for (const key of [...keys].reverse()) leaf = { [key]: leaf }
  record['plain'] = leaf
  return { record, messages, secrets, plain: { value, path: `plain.${keys.join('.')}.password` } }
}

function written(
  extra: Partial<BymaxLoggerModuleOptions>,
  record: Record<string, unknown>
): string {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  new PinoLoggerService(pino, resolveNameRedactor(options)).info('KEY', 'hello', 'u1', record)
  return lines[0] ?? ''
}

describe("an Error anywhere in the record, under redactStrategy 'paths'", () => {
  const pick = random(SEED)
  const drawn = Array.from({ length: CASES }, (_, id) => draw(pick, id))

  it.each([
    ['no consumer path', (_d: Drawn) => []],
    ['an unrelated consumer path', (_d: Drawn) => ['unrelated.path', 'other.*.thing']],
    ['a wildcard path aimed at stacks', (_d: Drawn) => ['*.*.error.stack', 'x.y']]
  ])('writes every Error and no default-name secret in it, with %s', (_name, paths) => {
    for (const [index, item] of drawn.entries()) {
      const line = written({ redactStrategy: 'paths', redactPaths: paths(item) }, item.record)

      for (const secret of item.secrets)
        expect([index, line.includes(secret)]).toEqual([index, false])
      for (const message of item.messages)
        expect([index, line.includes(message)]).toEqual([index, true])
    }
  })

  it('leaves data that is not an Error in clear beyond the default paths, unless a configured path names it', () => {
    for (const [index, item] of drawn.entries()) {
      const bare = written({ redactStrategy: 'paths' }, item.record)
      const named = written(
        { redactStrategy: 'paths', redactPaths: [item.plain.path] },
        item.record
      )

      expect([index, bare.includes(item.plain.value)]).toEqual([index, true])
      expect([index, named.includes(item.plain.value)]).toEqual([index, false])
    }
  })

  it('writes the same Errors, with the same secrets censored, as the names strategy does', () => {
    for (const [index, item] of drawn.entries()) {
      const names = written({}, item.record)
      const paths = written({ redactStrategy: 'paths' }, item.record)

      for (const secret of item.secrets) {
        expect([index, names.includes(secret), paths.includes(secret)]).toEqual([
          index,
          false,
          false
        ])
      }
      for (const message of item.messages) {
        expect([index, names.includes(message), paths.includes(message)]).toEqual([
          index,
          true,
          true
        ])
      }
    }
  })
})
