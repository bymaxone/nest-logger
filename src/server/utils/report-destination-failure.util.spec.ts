/**
 * Covers reportDestinationFailure, safeMinLevel and safeDestinationName: one stderr line per
 * failure, an unreadable cause degrades to a stand-in, an unreadable or unrecognised minLevel
 * counts as absent, a stateful getter is read once, an unreadable name becomes unknown.
 * Layer: server/utils, tests.
 */
import {
  reportDestinationFailure,
  safeDestinationName,
  safeMinLevel
} from './report-destination-failure.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { LogLevel } from '../../shared/types/log-level.type'

describe('reportDestinationFailure', () => {
  let stderrSpy: jest.SpyInstance

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  /** The single line the reporter wrote, parsed; fails when it wrote none or several. */
  const reported = (): Record<string, unknown> => {
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    return JSON.parse(String(stderrSpy.mock.calls[0]?.[0])) as Record<string, unknown>
  }

  /*
   * The ordinary case: an Error keeps its own name and message, so the stand-in
   * below is only for a value that cannot be read.
   */
  it('reports an Error with its own type and message', () => {
    reportDestinationFailure(
      RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
      'audit-sink',
      new TypeError('disk full'),
      'entry dropped'
    )

    expect(reported()).toMatchObject({
      logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
      destination: 'audit-sink',
      err: { type: 'TypeError', message: 'disk full' },
      msg: 'entry dropped'
    })
  })

  it.each([
    ['a null-prototype object, which has no toString', () => Object.create(null) as unknown],
    [
      'a value whose toString throws',
      () => ({
        toString(): string {
          throw new Error('hostile toString')
        }
      })
    ],
    [
      'an Error whose message getter throws',
      () =>
        Object.defineProperty(new Error('x'), 'message', {
          get(): string {
            throw new Error('hostile message getter')
          }
        })
    ],
    [
      'an Error whose name getter throws',
      () =>
        Object.defineProperty(new Error('x'), 'name', {
          get(): string {
            throw new Error('hostile name getter')
          }
        })
    ]
  ])('still reports the destination when the cause is %s', (_label, makeCause) => {
    /*
     * A destination failure always leaves one operator-visible line. The destination and
     * the stage are what the operator needs, and neither depends on the cause being
     * readable, so an unreadable cause degrades to a stand-in for the error instead of
     * dropping the line: a sink that stops receiving entries must never do so unannounced.
     * Exactly one line, never zero.
     */
    reportDestinationFailure(
      RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
      'audit-sink',
      makeCause(),
      'entry dropped'
    )

    expect(reported()).toMatchObject({
      logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
      destination: 'audit-sink',
      err: { type: 'UnknownError', message: 'unreadable value' },
      msg: 'entry dropped'
    })
  })

  /*
   * The message of the cause is a copy of the field `err.message` of an entry, so it passes the same
   * censor before it is bounded: a credential in the address a driver could not reach must not reach
   * stderr because the line was written by the library and not by the logger. The type is not a
   * message and is written as it is.
   */
  describe('the censor of the message of the cause', () => {
    const censor = (text: string): string => (text.includes('SECRET') ? '[REDACTED]' : text)

    it.each([
      ['an Error', new Error('connect to https://u:SECRET@host')],
      ['a string', 'connect to https://u:SECRET@host'],
      ['a value with a toString', { toString: (): string => 'connect to https://u:SECRET@host' }]
    ])('hides what it censors in the message of %s', (_label, cause) => {
      reportDestinationFailure(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
        'audit-sink',
        cause,
        'entry dropped',
        0,
        censor
      )

      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).not.toContain('SECRET')
      expect((reported()['err'] as { message: string }).message).toBe('[REDACTED]')
    })

    it('keeps the type of the error and a message that the censor leaves', () => {
      reportDestinationFailure(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
        'audit-sink',
        new TypeError('disk full'),
        'entry dropped',
        0,
        censor
      )

      expect(reported()['err']).toEqual({ type: 'TypeError', message: 'disk full' })
    })

    it('censors the whole message before it is bounded, so a secret the cut would split is hidden', () => {
      // The message is cut at 16,384 characters: this secret starts inside the cut and ends past it.
      const split = `${'x'.repeat(16_382)}SECRET${'y'.repeat(100)}`

      reportDestinationFailure(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
        'audit-sink',
        new Error(split),
        'entry dropped',
        0,
        censor
      )

      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).not.toContain('SEC')
      expect(reported()['err']).toEqual({ type: 'Error', message: '[REDACTED]' })
    })

    it('writes the stand-in and never the message when the censor throws', () => {
      reportDestinationFailure(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
        'audit-sink',
        new Error('SECRET'),
        'entry dropped',
        0,
        () => {
          throw new Error('censor failed')
        }
      )

      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).not.toContain('SECRET')
      expect(reported()['err']).toEqual({ type: 'UnknownError', message: 'unreadable value' })
    })

    it('leaves the message as it is when no censor is given', () => {
      reportDestinationFailure(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
        'audit-sink',
        new Error('SECRET'),
        'entry dropped'
      )

      expect(reported()['err']).toEqual({ type: 'Error', message: 'SECRET' })
    })
  })
})

describe('safeMinLevel', () => {
  /*
   * The ordinary case: a plain `minLevel` comes back unchanged, so the guard does
   * not alter what a well-behaved destination configures.
   */
  it('returns a plain minLevel unchanged', () => {
    expect(safeMinLevel({ minLevel: 'error' })).toBe('error')
  })

  /*
   * A destination without a `minLevel` and one whose getter throws give the SAME
   * answer, because both mean "no usable per-destination level" and the callers
   * fall back to the module level in either case.
   */
  it('treats an unreadable minLevel as absent', () => {
    const hostile = {
      get minLevel(): LogLevel {
        throw new Error('minLevel getter exploded')
      }
    }

    expect(safeMinLevel({})).toBeUndefined()
    expect(safeMinLevel(hostile)).toBeUndefined()
  })

  /*
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
  it('pins the first answer so a stateful getter cannot disagree with itself', () => {
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

  /*
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
  it('treats an unrecognised level as absent rather than passing it through', () => {
    // Parsed rather than asserted, because that is how the value really arrives: a
    // level read from configuration crosses into the type system without being
    // checked by it. `'verbose'` is a real NestJS level name and a natural thing to
    // write; it is not one of Pino's six.
    const miscast: { readonly minLevel?: LogLevel } = JSON.parse('{"minLevel":"verbose"}')

    expect(safeMinLevel(miscast)).toBeUndefined()
  })

  /*
   * The cache is per destination, not global: two destinations configured
   * differently must keep their own levels.
   */
  it('keeps each destination on its own level', () => {
    expect(safeMinLevel({ minLevel: 'warn' })).toBe('warn')
    expect(safeMinLevel({ minLevel: 'debug' })).toBe('debug')
  })
})

describe('safeDestinationName', () => {
  /*
   * The ordinary case, so the guard does not alter a well-behaved name.
   */
  it('returns a plain name unchanged', () => {
    expect(safeDestinationName({ name: 'stdout-json' })).toBe('stdout-json')
  })

  /*
   * A throwing `name` getter yields the `unknown` placeholder rather than escaping:
   * every reporter calls this from inside a catch, where a throw would abort the
   * teardown or bootstrap that catch exists to protect.
   */
  it('falls back to unknown when the name cannot be read', () => {
    const hostile = {
      get name(): string {
        throw new Error('name getter exploded')
      }
    }

    expect(safeDestinationName(hostile)).toBe('unknown')
  })
})
