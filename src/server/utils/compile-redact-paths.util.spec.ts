import { DEFAULT_REDACT_PATHS } from '../constants/default-redact-paths.constants'
import { compileRedactPaths } from './compile-redact-paths.util'

describe('compileRedactPaths', () => {
  it(/*
   * The merged list must include every default plus the consumer extras —
   * critical for PII protection: dropping a default would silently widen
   * the redaction surface.
   */
  'should merge DEFAULT_REDACT_PATHS with consumer extras', () => {
    const result = compileRedactPaths(['*.foo'], false)
    expect(result).toContain('*.password')
    expect(result).toContain('*.foo')
    expect(result.length).toBeGreaterThanOrEqual(DEFAULT_REDACT_PATHS.length + 1)
  })

  it(/*
   * Duplicate entries between defaults and extras must collapse to one.
   * `fast-redact` historically throws on duplicates — this dedup is a hard
   * correctness requirement, not just a tidy-up.
   */
  'should deduplicate entries present in both sources', () => {
    const result = compileRedactPaths(['*.password'], false)
    const occurrences = result.filter((p) => p === '*.password').length
    expect(occurrences).toBe(1)
  })

  it(/*
   * When the consumer opts out of defaults, only the extras must survive.
   * Confirms the disable-default branch does not silently keep any
   * canonical paths.
   */
  'should return only extras when disableDefault is true', () => {
    const result = compileRedactPaths(['*.only'], true)
    expect(result).toEqual(['*.only'])
    expect(result).not.toContain('*.password')
  })

  it(/*
   * Empty extras combined with disableDefault must yield an empty array,
   * not undefined or the defaults — defensive against an extra-paths
   * argument that was forgotten upstream.
   */
  'should return an empty array when extras are empty and disableDefault is true', () => {
    expect(compileRedactPaths([], true)).toEqual([])
  })

  it(/*
   * Empty extras with defaults enabled must yield exactly the defaults
   * deduplicated — guards against an accidental insertion of an extra
   * element when extras is empty.
   */
  'should return exactly the defaults when extras are empty and disableDefault is false', () => {
    const result = compileRedactPaths([], false)
    expect(result.length).toBe(new Set(DEFAULT_REDACT_PATHS).size)
  })
})
