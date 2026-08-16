import { safeDestinationName, safeMinLevel } from './report-destination-failure.util'
import type { LogLevel } from '../../shared/types/log-level.type'

describe('safeMinLevel', () => {
  it(/*
   * The ordinary case: a plain `minLevel` comes back unchanged, so the guard does
   * not alter what a well-behaved destination configures.
   */
  'returns a plain minLevel unchanged', () => {
    expect(safeMinLevel({ minLevel: 'error' })).toBe('error')
  })

  it(/*
   * A destination without a `minLevel` and one whose getter throws give the SAME
   * answer, because both mean "no usable per-destination level" and the callers
   * fall back to the module level in either case.
   */
  'treats an unreadable minLevel as absent', () => {
    const hostile = {
      get minLevel(): LogLevel {
        throw new Error('minLevel getter exploded')
      }
    }

    expect(safeMinLevel({})).toBeUndefined()
    expect(safeMinLevel(hostile)).toBeUndefined()
  })

  it(/*
   * REGRESSION — a STATEFUL getter must not be able to answer differently to
   * different readers. The value is read by two independent consumers: the factory,
   * which fixes the multistream entry's level, and the registry, which records the
   * same destination's health level. A getter returning `info` to one and `error`
   * to the other would let an `error` sink be credited with covering held `info`
   * entries, and a buffering destination would discard its only copy of them.
   *
   * Asserted by reading three times through a getter that changes on every access:
   * without the cache the second read already differs.
   */
  'pins the first answer so a stateful getter cannot disagree with itself', () => {
    const levels: LogLevel[] = ['info', 'error', 'fatal']
    let reads = 0
    const shifting = {
      get minLevel(): LogLevel {
        const level = levels[reads] ?? 'trace'
        reads += 1
        return level
      }
    }

    const first = safeMinLevel(shifting)

    expect(first).toBe('info')
    expect(safeMinLevel(shifting)).toBe(first)
    expect(safeMinLevel(shifting)).toBe(first)
    // The getter ran once. Everything after came from the pinned answer.
    expect(reads).toBe(1)
  })

  it(/*
   * REGRESSION — the declared type is a compile-time claim a JavaScript consumer
   * does not have to keep. An unrecognised level is NOT rejected by
   * `pino.multistream`: it builds without complaint and the entry then matches
   * nothing, so the destination receives zero entries while the registry — whose
   * `indexOf` returns -1 and loses the comparison — records it as covering the
   * module level. Silent total loss for that sink.
   *
   * Treated as absent so the destination falls back to the module level and keeps
   * receiving. Reverting the `isLogLevel` check makes this fail.
   */
  'treats an unrecognised level as absent rather than passing it through', () => {
    // Parsed rather than asserted, because that is how the value really arrives: a
    // level read from configuration crosses into the type system without being
    // checked by it. `'verbose'` is a real NestJS level name and a natural thing to
    // write; it is not one of Pino's six.
    const miscast: { readonly minLevel?: LogLevel } = JSON.parse('{"minLevel":"verbose"}')

    expect(safeMinLevel(miscast)).toBeUndefined()
  })

  it(/*
   * The cache is per destination, not global: two destinations configured
   * differently must keep their own levels.
   */
  'keeps each destination on its own level', () => {
    expect(safeMinLevel({ minLevel: 'warn' })).toBe('warn')
    expect(safeMinLevel({ minLevel: 'debug' })).toBe('debug')
  })
})

describe('safeDestinationName', () => {
  it(/*
   * The ordinary case, so the guard does not alter a well-behaved name.
   */
  'returns a plain name unchanged', () => {
    expect(safeDestinationName({ name: 'stdout-json' })).toBe('stdout-json')
  })

  it(/*
   * A throwing `name` getter yields the `unknown` placeholder rather than escaping:
   * every reporter calls this from inside a catch, where a throw would abort the
   * teardown or bootstrap that catch exists to protect.
   */
  'falls back to unknown when the name cannot be read', () => {
    const hostile = {
      get name(): string {
        throw new Error('name getter exploded')
      }
    }

    expect(safeDestinationName(hostile)).toBe('unknown')
  })
})
