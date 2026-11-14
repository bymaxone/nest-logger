/**
 * Pins that path exclusion gives the same answer on repeated calls for a global pattern, still matches case-insensitively when the pattern has the `i` flag, and tolerates a frozen pattern without the global or sticky flag.
 * Layer: server/utils, tests.
 */
import { matchesExcludePath } from './matches-exclude-path.util'

describe('matchesExcludePath', () => {
  /*
   * The defect this exists for. A `g` pattern carries a match position: `test()`
   * advances `lastIndex` and the next call resumes from it, so the same pattern
   * against the same path alternates true/false. Measured on `/^\/health$/g`:
   * true, false, true, false. The patterns are shared by the access-log
   * middleware and the HTTP interceptor for the process lifetime, so a consumer
   * carrying a `g` flag in from a copied pattern saw excluded health checks
   * reappear at half rate, silently. Four consecutive calls is what two mounts
   * across two requests actually do.
   */
  it('matches a global pattern consistently across repeated calls', () => {
    const patterns = [/^\/health$/g]

    expect([
      matchesExcludePath(patterns, '/health'),
      matchesExcludePath(patterns, '/health'),
      matchesExcludePath(patterns, '/health'),
      matchesExcludePath(patterns, '/health')
    ]).toEqual([true, true, true, true])
  })

  /*
   * The sticky flag has the same resume behaviour and must be neutralised too —
   * `y` is rarer but reaches the identical failure.
   */
  it('matches a sticky pattern consistently across repeated calls', () => {
    const patterns = [/^\/metrics$/y]

    expect([
      matchesExcludePath(patterns, '/metrics'),
      matchesExcludePath(patterns, '/metrics')
    ]).toEqual([true, true])
  })

  /*
   * A non-matching path must stay non-matching however many times it is asked —
   * the reset must not turn a miss into a hit, which is the failure that would
   * silently DROP traffic from the log rather than duplicate it.
   */
  it('reports no match for a path outside every pattern', () => {
    const patterns = [/^\/health$/g, /^\/metrics$/]

    expect(matchesExcludePath(patterns, '/users/7')).toBe(false)
    expect(matchesExcludePath(patterns, '/users/7')).toBe(false)
  })

  /*
   * The ordinary anchored pattern the defaults ship, which has no position to
   * reset — the fix must not depend on the flag being present.
   */
  it('matches a plain anchored pattern', () => {
    expect(matchesExcludePath([/^\/health$/], '/health')).toBe(true)
  })

  /*
   * An empty pattern list excludes nothing. `some` on an empty array is `false`,
   * and a consumer who sets `excludePaths: []` is asking for every request to be
   * logged, including the probes.
   */
  it('excludes nothing when no patterns are configured', () => {
    expect(matchesExcludePath([], '/health')).toBe(false)
  })

  /*
   * Flags that say WHAT matches are the consumer's expressed intent and are
   * untouched: only the match POSITION is neutralised. Stripping `i` would
   * silently change which routes are excluded.
   */
  it('honours case-insensitivity while neutralising the position', () => {
    const patterns = [/^\/HEALTH$/giu]

    expect(matchesExcludePath(patterns, '/health')).toBe(true)
    expect(matchesExcludePath(patterns, '/health')).toBe(true)
  })
  /*
   * REGRESSION — a FROZEN pattern without the stateful flags must still work.
   *
   * A consumer can deep-freeze a config module, which reaches the regexes in it,
   * and `Object.freeze` makes `lastIndex` non-writable. Measured under ESM's
   * strict mode: `.test()` on such a pattern works, while assigning to its
   * `lastIndex` throws "Cannot assign to read only property 'lastIndex'". An
   * unconditional reset therefore turned a working configuration into a throw on
   * the request path, in both the middleware and the interceptor. This is the
   * case that makes the flag guard load-bearing rather than cosmetic.
   */
  it('matches a frozen non-global pattern without writing to it', () => {
    const patterns = [Object.freeze(/^\/health$/)]

    expect(() => matchesExcludePath(patterns, '/health')).not.toThrow()
    expect(matchesExcludePath(patterns, '/health')).toBe(true)
    expect(matchesExcludePath(patterns, '/users/7')).toBe(false)
  })
})
