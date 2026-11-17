/**
 * Specifies `maxStringLength` as a property of the whole path from a record to its output: on any
 * record, (a) no secret appears with the limit that is absent without it, (b) no censor is lost,
 * (c) what the option leaves whole (the root `logKey`, a value under a serialized key and
 * everything inside an `Error`) is exactly what the redactor writes without it, and (d) every other
 * string is at most the limit plus the marker long. The records include a header array reached
 * through a `toJSON` result, header arrays inside arrays of objects, and values under a serialized
 * key and inside an `Error`. They are drawn from a fixed seed, so a failure names a case that can
 * be run again.
 *
 * Layer: server, tests.
 */
import { REDACT_COMMON_FIELDS } from './constants/default-redact-paths.constants'
import { TEXT_TRUNCATED } from './utils/bounded-text.util'
import { cutStrings } from './utils/cut-strings.util'
import { createNameRedactor } from './utils/redact-by-name.util'

const SEED = 20261118
const CASES = 1500
const LIMIT = 64
// Exactly the limit, the longest censor the options allow: a pass that cut it would lose every censor.
const CENSOR = '[REDACTED:' + 'c'.repeat(LIMIT - 11) + ']'
const LONG_NAME = 'x-' + 's'.repeat(LIMIT + 8)
const SENSITIVE_NAMES = [...REDACT_COMMON_FIELDS, LONG_NAME]
const HEADER_NAMES = ['authorization', 'Cookie', 'set-cookie', 'X-API-Key', LONG_NAME, 'accept']
const KEYS = ['password', 'token', 'authorization', 'cookie', 'a', 'b', 'meta', LONG_NAME]
const SERIALIZED = ['err', 'order']

/** A deterministic generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

type Pick = () => number

/** A text that starts with `prefix`, the secret marker, and is followed by 0 to 200 characters. */
function padded(pick: Pick, prefix: string): string {
  return prefix + 'p'.repeat(Math.floor(pick() * 200))
}

/** A flat `[name, value, ...]` array of raw headers, each value marked. */
function rawHeaders(pick: Pick, mark: () => string): string[] {
  const out: string[] = []
  for (let index = 0; index < 1 + Math.floor(pick() * 4); index++) {
    out.push(HEADER_NAMES[Math.floor(pick() * HEADER_NAMES.length)] as string, padded(pick, mark()))
  }
  return out
}

/** A header array in one of the forms the walk reaches it: direct, behind `toJSON`, or nested. */
function headerHolder(pick: Pick, mark: () => string): unknown {
  const draw = pick()
  // What `toJSON` returns is built once, so every redactor that reads it reads the same value.
  if (draw < 0.3) return rawHeaders(pick, mark)
  if (draw < 0.55) {
    const held = rawHeaders(pick, mark)
    return { toJSON: () => held }
  }
  if (draw < 0.8) return [{ rawHeaders: rawHeaders(pick, mark) }, 'x'.repeat(100)]
  const held = { rawHeaders: rawHeaders(pick, mark), note: padded(pick, mark()) }
  return { toJSON: () => held }
}

/**
 * One value: a marked secret, a number, an array or an object of them, or a header holder, and an
 * `Error` where `errors` allows one: an `Error` is written whole, so the length property skips the
 * roots that hold one.
 */
function value(pick: Pick, depth: number, mark: () => string, errors = false): unknown {
  const draw = pick()
  if (depth <= 0 || draw < 0.25) return padded(pick, mark())
  if (draw < 0.3) return [1, true, null][Math.floor(pick() * 3)]
  if (draw < 0.45)
    return Array.from({ length: 1 + Math.floor(pick() * 3) }, () =>
      value(pick, depth - 1, mark, errors)
    )
  if (draw < 0.55) return headerHolder(pick, mark)
  if (errors && draw < 0.65) {
    const error = Object.assign(new Error(padded(pick, mark())), { detail: padded(pick, mark()) })
    error.stack = `Error: m\n${padded(pick, mark())}`
    return error
  }
  const record: Record<string, unknown> = {}
  for (let index = 0; index < 1 + Math.floor(pick() * 4); index++) {
    record[KEYS[Math.floor(pick() * KEYS.length)] as string] = value(pick, depth - 1, mark, errors)
  }
  return record
}

/** The record of a case: nested values, the header keys, header arrays and serialized subtrees. */
function recordOf(pick: Pick, mark: () => string): Record<string, unknown> {
  return {
    ...(value(pick, 3, mark) as Record<string, unknown>),
    logKey: 'EVENT_' + 'K'.repeat(Math.floor(pick() * 120)),
    headers: { Authorization: padded(pick, mark()), Cookie: padded(pick, mark()) },
    rawHeaders: headerHolder(pick, mark),
    rawTrailers: headerHolder(pick, mark),
    req: { rawHeaders: rawHeaders(pick, mark), note: padded(pick, mark()) },
    err: value(pick, 2, mark, true),
    order: value(pick, 2, mark, true),
    note: padded(pick, mark())
  }
}

/** The markers in the serialized output, and how many censors it holds. */
function summary(output: unknown): { markers: Set<string>; censors: number } {
  const text = JSON.stringify(output)
  return {
    markers: new Set(text.match(/SECRET-\d+-/g) ?? []),
    censors: text.split(CENSOR).length - 1
  }
}

/** Every string longer than the limit plus the marker, outside the root keys left whole. */
function overlong(output: unknown, exempt: ReadonlySet<string>): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.length > LIMIT + TEXT_TRUNCATED.length) found.push(node.slice(0, 24))
    } else if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) visit(child)
    }
  }
  for (const [key, child] of Object.entries(output as Record<string, unknown>)) {
    if (!exempt.has(key)) visit(child)
  }
  return found
}

type Broken = Record<'exposedSecret' | 'lostCensor' | 'exemptChanged' | 'overlongString', number[]>

/** The cases among `CASES` records where a property of the limited output fails. */
function surveyBroken(
  limited: (
    record: Record<string, unknown>,
    without: Record<string, unknown>
  ) => Record<string, unknown>
): Broken {
  const redactor = createNameRedactor(
    SENSITIVE_NAMES,
    CENSOR,
    SERIALIZED,
    undefined,
    undefined,
    undefined,
    undefined
  )
  const pick = random(SEED)
  const exempt = new Set(['logKey', ...SERIALIZED])
  const broken: Broken = {
    exposedSecret: [],
    lostCensor: [],
    exemptChanged: [],
    overlongString: []
  }
  for (let index = 0; index < CASES; index++) {
    let counter = 0
    const mark = (): string => `SECRET-${String(index)}${String(counter++)}-`
    const record = recordOf(pick, mark)
    const without = redactor(record, true) as Record<string, unknown>
    const after = limited(record, without)
    const before = summary(without)
    const now = summary(after)
    if ([...now.markers].some((marker) => !before.markers.has(marker)))
      broken.exposedSecret.push(index)
    if (now.censors < before.censors) broken.lostCensor.push(index)
    if ([...exempt].some((key) => JSON.stringify(after[key]) !== JSON.stringify(without[key]))) {
      broken.exemptChanged.push(index)
    }
    if (overlong(after, exempt).length > 0) broken.overlongString.push(index)
  }
  return broken
}

const NONE: Broken = { exposedSecret: [], lostCensor: [], exemptChanged: [], overlongString: [] }

/** The first cases of each property that fails, so a failure names records to run again. */
function firstCases(broken: Broken): Broken {
  return {
    exposedSecret: broken.exposedSecret.slice(0, 5),
    lostCensor: broken.lostCensor.slice(0, 5),
    exemptChanged: broken.exemptChanged.slice(0, 5),
    overlongString: broken.overlongString.slice(0, 5)
  }
}

describe(`maxStringLength, as a property of ${String(CASES)} records`, () => {
  const exempt = new Set(['logKey', ...SERIALIZED])

  it('holds (a) to (d) for the cut applied to the output of the redactor', () => {
    const broken = surveyBroken(
      (_record, without) => cutStrings(without, LIMIT, exempt) as Record<string, unknown>
    )

    expect(firstCases(broken)).toEqual(NONE)
  })
})
