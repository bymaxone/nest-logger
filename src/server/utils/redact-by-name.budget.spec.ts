/**
 * Pins the visit budget of one redaction call: the walk expands an object once per path that reaches
 * it, so a graph that shares references must stop growing at a fixed number of container visits.
 * The bounds are counts of containers and characters, never wall time.
 *
 * Layer: server/utils, tests.
 */
import { applyDefaults } from '../config/default-options'
import { buildPinoInstance, resolveNameRedactor } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'
import {
  REDACT_BUDGET_EXCEEDED,
  REDACT_MAX_VISITS,
  createNameRedactor
} from './redact-by-name.util'

const redact = createNameRedactor(['password'], '[REDACTED]', ['err'])

/** A graph in which every level holds the next one twice: `2 ** levels` paths, `levels` objects. */
function sharedGraph(levels: number): object {
  let node: object = { leaf: 1 }
  for (let level = 0; level < levels; level++) node = { left: node, right: node }
  return node
}

/** An Error whose `name` and `message` are the next Error, `links` deep. */
function linkedByNameAndMessage(links: number): Error {
  let held: Error = new Error('leaf')
  for (let level = 0; level < links; level++) {
    const link = new Error(`link${level}`)
    Object.defineProperty(link, 'name', { value: held })
    Object.defineProperty(link, 'message', { value: held })
    held = link
  }
  return held
}

/** The deepest object nesting in a walked value. */
function nesting(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  return 1 + Math.max(0, ...Object.values(value).map(nesting))
}

/** How many times the budget marker appears in the walked value. */
function markers(value: unknown): number {
  return JSON.stringify(value).split(REDACT_BUDGET_EXCEEDED).length - 1
}

/** A budget small enough to reach with a few objects: the rule is the same at any size. */
const SMALL = 40

const small = createNameRedactor(['password'], '[REDACTED]', ['err'], SMALL)

describe('the visit budget of one redaction call', () => {
  it('is the documented number of containers, with the documented marker', () => {
    expect(REDACT_MAX_VISITS).toBe(200_000)
    expect(REDACT_BUDGET_EXCEEDED).toBe('[REDACTION_BUDGET_EXCEEDED]')
  })

  /*
   * `{ meta: { big } }` is three containers (the record, `meta` and the array) before its elements,
   * so an array of `budget - 3` objects uses the whole budget and one more does not fit.
   */
  it('keeps every container up to the budget and replaces the first one past it', () => {
    const fits = Array.from({ length: SMALL - 3 }, (_, index) => ({ index }))
    const over = [...fits, { index: fits.length }]

    const kept = small({ meta: { big: fits } }, true) as { meta: { big: unknown[] } }
    const cut = small({ meta: { big: over } }, true) as { meta: { big: unknown[] } }

    expect(markers(kept)).toBe(0)
    expect(kept.meta.big).toHaveLength(fits.length)
    expect(cut.meta.big).toHaveLength(over.length)
    expect(cut.meta.big.at(-1)).toBe(REDACT_BUDGET_EXCEEDED)
    expect(cut.meta.big.at(-2)).toStrictEqual({ index: fits.length - 1 })
  })

  it('applies the documented number when none is given', () => {
    const fits = Array.from({ length: REDACT_MAX_VISITS - 3 }, (_, index) => ({ index }))

    const kept = redact({ meta: { big: fits } }, true) as { meta: { big: unknown[] } }
    const cut = redact({ meta: { big: [...fits, { index: fits.length }] } }, true) as {
      meta: { big: unknown[] }
    }

    expect(markers(kept)).toBe(0)
    expect(cut.meta.big.at(-1)).toBe(REDACT_BUDGET_EXCEEDED)
    expect(cut.meta.big.at(-2)).toStrictEqual({ index: fits.length - 1 })
  })

  it('stops a graph that shares references long before its paths are walked', () => {
    // 2 ** 40 paths: unbounded, this never finishes and its output cannot be held.
    const walked = small({ meta: { graph: sharedGraph(40) } }, true)

    expect(markers(walked)).toBeGreaterThan(0)
    expect(JSON.stringify(walked).length).toBeLessThan(SMALL * 64)
  })

  it('keeps the primitives beside a container that is cut, and censors what it still walks', () => {
    const walked = small(
      { meta: { graph: sharedGraph(40), keep: 'beside', password: 'secret' } },
      true
    ) as { meta: Record<string, unknown> }

    expect(walked.meta['keep']).toBe('beside')
    expect(walked.meta['password']).toBe('[REDACTED]')
  })

  it('starts every call with a full budget', () => {
    const first = small({ meta: { graph: sharedGraph(40) } }, true)
    const second = small({ meta: { small: { a: [1, 2, 3] } } }, true)

    expect(markers(first)).toBeGreaterThan(0)
    expect(second).toStrictEqual({ meta: { small: { a: [1, 2, 3] } } })
  })

  it('counts a cause that is a very large array like any other container', () => {
    const big = Array.from({ length: SMALL + 10 }, (_, index) => ({ index }))

    const walked = small({ meta: { e: new Error('x', { cause: big }) } }, true) as {
      meta: { e: { cause: unknown[] } }
    }

    expect(walked.meta.e.cause.at(-1)).toBe(REDACT_BUDGET_EXCEEDED)
    expect(walked.meta.e.cause.length).toBe(big.length)
  })

  it('bounds the links of an Error held in both name and message, by the chain budget', () => {
    const held = linkedByNameAndMessage(12)

    const walked = redact({ meta: { held } }, true)

    // Three links deep, then the marker: 2 ** 12 paths would otherwise each be nested in the next.
    expect(JSON.stringify(walked)).toContain('cause-depth-exceeded')
    expect(nesting((walked as { meta: { held: unknown } }).meta.held)).toBeLessThan(8)
  })
})

describe('the visit budget through the real pipeline', () => {
  it('writes a record whose metadata shares references, with the marker, and does not fail it', () => {
    const lines: string[] = []
    const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
    const pino = buildPinoInstance(
      options,
      new LogContextService(),
      [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
      new DestinationHealth()
    )

    new PinoLoggerService(pino, resolveNameRedactor(options)).errorStructured(
      'KEY',
      new Error('root'),
      'u1',
      { graph: sharedGraph(40), keep: 'beside' }
    )

    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry.logKey).toBe('KEY')
    expect(entry.keep).toBe('beside')
    expect(lines[0]).toContain(REDACT_BUDGET_EXCEEDED)
    expect(entry).not.toHaveProperty('_redactionFailed')
  })

  it('bounds the line when the stack of a nested Error is megabytes long', () => {
    // V8 builds the stack header of such a chain by stringifying the links: it doubles per link.
    const held = linkedByNameAndMessage(18)
    expect(held.stack?.length).toBeGreaterThan(1_000_000)
    const lines: string[] = []
    const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
    const pino = buildPinoInstance(
      options,
      new LogContextService(),
      [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
      new DestinationHealth()
    )
    const service = new PinoLoggerService(pino, resolveNameRedactor(options))

    service.errorStructured('KEY', new Error('root'), 'u1', { held })
    service.errorStructured('KEY', held, 'u1', {})

    // Three links with two branches each is 15 nodes, and each stack is cut at 16 KiB: a few hundred
    // kilobytes at most, where the stacks alone were tens of megabytes.
    expect(lines[0]?.length).toBeLessThan(400_000)
    // The root error's own slot, not the log message: that is the caller's text, written as given.
    expect(JSON.stringify(JSON.parse(lines[1] ?? '{}').err).length).toBeLessThan(400_000)
    expect(lines[0]).toContain('…[truncated]')
  })
})
