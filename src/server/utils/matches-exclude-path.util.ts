/**
 * Stateless exclude-path matching, shared by the two components that do it.
 *
 * Layer: server/utils — the access-log middleware and the HTTP interceptor both
 * decide whether a request bypasses logging, against the SAME frozen array of
 * `RegExp` objects held in module options for the lifetime of the process.
 *
 * Why this is not an inline `.some((p) => p.test(path))`. A pattern carrying `g`
 * or `y` keeps a match position: `test()` advances its `lastIndex` and the next
 * call resumes from there, so the same pattern tested twice against the same
 * path alternates. Measured on `/^\/health$/g` against `'/health'`:
 *
 *   test #1: true   lastIndex=7
 *   test #2: false  lastIndex=0
 *   test #3: true   lastIndex=7
 *   test #4: false  lastIndex=0
 *
 * A `g` flag is meaningless on an anchored path test and easy to carry in from a
 * copied pattern, and the consequence is silent: excluded health checks reappear
 * at half rate with no error and nothing to suggest the configuration is not
 * working. With both wiring helpers mounted the two mounts test the same pattern
 * twice within one request and disagree outright.
 *
 * Resetting the position before each test is what makes the answer depend only
 * on the pattern and the path. The alternative — rebuilding each pattern without
 * those flags when options resolve — reconstructs a consumer's `RegExp` through
 * `new RegExp(pattern.source, …)`, which is a non-literal constructor call this
 * repository's security lint flags, and rightly: it is the shape that carries
 * ReDoS when a source is not trusted. Keeping the consumer's own objects and
 * neutralising only the position avoids that entirely.
 *
 * The write is safe under concurrency: there is no await between the assignment
 * and the test, so no other request can interleave and observe a stale position.
 * It happens only for a pattern that actually carries a position, so a frozen
 * pattern without those flags is never written to.
 */

/**
 * Whether `path` matches any of `patterns`, independent of match position.
 *
 * @param patterns - The configured exclude patterns (`http.excludePaths`).
 * @param path - The request path, already stripped of its query string.
 * @returns `true` when the request bypasses HTTP logging.
 */
export function matchesExcludePath(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((pattern) => {
    // Guarded on the flags, and the guard is load-bearing rather than cosmetic.
    // A consumer can hand over a FROZEN pattern — a deep-freeze over a config
    // module reaches the regexes in it — and `Object.freeze` makes `lastIndex`
    // non-writable. Measured under ESM's strict mode: a frozen NON-global pattern
    // still tests fine, while assigning to its `lastIndex` throws
    // `TypeError: Cannot assign to read only property 'lastIndex'`. Writing
    // unconditionally would therefore turn a working configuration into a throw
    // on the request path, in both the middleware and the interceptor.
    //
    // A pattern with neither flag has no stored position to clear, so skipping
    // the write costs nothing. The two arms differ for exactly the frozen
    // non-global case, which is what the test for it pins.
    //
    // A frozen pattern that IS global remains broken, and not by this: `test()`
    // writes `lastIndex` itself, so it throws before this function can help.
    // Un-breaking it would mean reconstructing the consumer's `RegExp`, which is
    // the non-literal constructor this repository's security lint refuses.
    if (pattern.global || pattern.sticky) {
      pattern.lastIndex = 0
    }
    return pattern.test(path)
  })
}
