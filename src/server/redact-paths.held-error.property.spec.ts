/**
 * Pins what is written under `err` for a held `Error` under `redactStrategy: 'paths'`, over chains
 * drawn from a fixed seed, so a failure names a case that can be run again. A chain mixes `Error`s,
 * `AggregateError`s and plain error-like objects, and some of its `Error`s write themselves with a
 * `toJSON` that returns a name, none, or a message of its own.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SEED = 20261128
const CASES = 400
// With the held Error above it, the longest chain stays inside the depth causes are written to.
const MAX_CHAIN = 3

/** A deterministic generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

type Holder = 'error' | 'aggregate' | 'plain'
type Output = 'none' | 'named' | 'nameless' | 'rewritten'

interface Link {
  readonly holder: Holder
  readonly output: Output
}

/** A plain object has no `toJSON` here; an `AggregateError` holds the next link in `errors`. */
function drawChain(pick: () => number): Link[] {
  const one = <T>(list: readonly T[]): T => list[Math.floor(pick() * list.length)] as T
  return Array.from({ length: 1 + Math.floor(pick() * MAX_CHAIN) }, () => {
    const holder = one<Holder>(['error', 'error', 'aggregate', 'plain'])
    const output =
      holder === 'plain' ? 'none' : one<Output>(['none', 'named', 'nameless', 'rewritten'])
    return { holder, output }
  })
}

function build(chain: readonly Link[], at: number): object | undefined {
  const link = chain[at]
  if (link === undefined) return undefined
  const below = build(chain, at + 1)
  const message = `message-${at}`
  if (link.holder === 'plain') return { name: 'Plain', message, ...(below && { cause: below }) }
  const error =
    link.holder === 'aggregate'
      ? new AggregateError(below ? [below] : [], message)
      : new Error(message, below ? { cause: below } : undefined)
  if (link.output === 'none') return error
  Object.defineProperty(error, 'toJSON', {
    value: () => ({
      ...(link.output !== 'nameless' && { name: error.name }),
      message: link.output === 'rewritten' ? 'scrubbed' : error.message,
      cause: error.cause,
      ...(error instanceof AggregateError && { errors: error.errors })
    })
  })
  return error
}

/** An `Error` the configured path holds, whose `toJSON` keeps its head and its cause. */
function held(chain: readonly Link[]): Error {
  const error = new Error('failed', { cause: build(chain, 0) })
  Object.defineProperty(error, 'inner', { value: { pan: 'x' } })
  Object.defineProperty(error, 'toJSON', {
    value: () => ({ name: error.name, message: error.message, cause: error.cause })
  })
  return error
}

/**
 * The links whose message is written. A `toJSON` without a name ends the chain, unless no `toJSON`
 * below that point would have run had the `Error` above stayed an instance: that is so below the
 * `cause` or `errors` of an `Error` with no `toJSON` of its own, and from there down.
 */
function expected(chain: readonly Link[]): number[] {
  const written: number[] = []
  let unread = false
  for (const [at, link] of chain.entries()) {
    if (link.output === 'nameless' && !unread) break
    if (link.output !== 'rewritten') written.push(at)
    unread ||= link.holder !== 'plain' && link.output === 'none'
  }
  return written
}

describe("a held Error under the err key, under redactStrategy 'paths'", () => {
  const lines: string[] = []
  const options = applyDefaults({
    service: { name: 'app', version: '1.0.0' },
    redactStrategy: 'paths',
    redactPaths: ['err.pan']
  })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  const service = new PinoLoggerService(pino, resolveNameRedactor(options))
  const pick = random(SEED)
  const chains = Array.from({ length: CASES }, () => drawChain(pick))

  it('writes the message of every link down to a nameless toJSON that ran before', () => {
    for (const [index, chain] of chains.entries()) {
      lines.length = 0
      service.info('KEY', 'hello', 'u1', { err: held(chain) })
      const line = lines[0] ?? ''
      const written = chain.map((_link, at) => at).filter((at) => line.includes(`message-${at}`))

      expect([index, written]).toEqual([index, expected(chain)])
    }
  })
})
