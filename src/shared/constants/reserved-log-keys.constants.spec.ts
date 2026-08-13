import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { LOG_KEYS_CONVENTION_REGEX } from './log-keys-convention.constants'
import {
  RESERVED_LOG_KEYS,
  RESERVED_LOG_KEYS_NOT_EMITTED,
  type ReservedLogKey
} from './reserved-log-keys.constants'

/** Absolute path to `src/`, walked to prove each reserved key has a writer. */
const SOURCE_ROOT = join(__dirname, '..', '..')

/** Every non-spec `.ts` file under `src/`, read once. */
function readProductionSources(directory: string): string[] {
  const collected: string[] = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, item.name)
    if (item.isDirectory()) {
      if (item.name !== 'coverage') {
        collected.push(...readProductionSources(full))
      }
    } else if (item.name.endsWith('.ts') && !item.name.endsWith('.spec.ts')) {
      collected.push(readFileSync(full, 'utf-8'))
    }
  }
  return collected
}

describe('RESERVED_LOG_KEYS', () => {
  it(/*
   * The runtime object must be frozen so consumers cannot mutate or extend
   * the reserved set, which would silently shift the meaning of indexed
   * log events in third-party dashboards.
   */
  'should be frozen at runtime', () => {
    expect(Object.isFrozen(RESERVED_LOG_KEYS)).toBe(true)
  })

  it(/*
   * Each entry must be a non-empty string so log consumers can safely
   * index on the value without nullability guards.
   */
  'should expose only non-empty string values', () => {
    const values = Object.values(RESERVED_LOG_KEYS)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it(/*
   * Every reserved value must satisfy the public MODULE_ACTION_RESULT
   * convention regex. Locks the library's own keys to the same shape it
   * asks consumers to use, preventing a credibility gap.
   */
  'should have every value matching LOG_KEYS_CONVENTION_REGEX', () => {
    for (const value of Object.values(RESERVED_LOG_KEYS)) {
      expect(LOG_KEYS_CONVENTION_REGEX.test(value)).toBe(true)
    }
  })

  it(/*
   * Key and value must be identical for each entry so consumers can map
   * either side back to the original constant without a reverse lookup.
   */
  'should mirror each key to its own value', () => {
    for (const [key, value] of Object.entries(RESERVED_LOG_KEYS)) {
      expect(value).toBe(key)
    }
  })

  it(/*
   * The derived ReservedLogKey type must cover exactly the runtime values.
   * Guards against silent drift between the type and the runtime object
   * (e.g., if a new key is added but the type derivation breaks).
   */
  'should match the ReservedLogKey union type via the values', () => {
    const values = Object.values(RESERVED_LOG_KEYS) as ReservedLogKey[]
    expect(values).toContain('LOGGER_BOOTSTRAP_OK')
    expect(values).toContain('HTTP_REQUEST_START')
    expect(values).toContain('LOGGER_ENTRY_TRUNCATED')
  })

  it(/*
   * REGRESSION — audit finding D-1. Three keys were declared, documented, and
   * never written by any code path. One of them, LOGGER_BOOTSTRAP_WARNING, was
   * sold in the README as the audit trail proving when PII protection had been
   * turned off: a team relying on it got silence. A declared key must therefore
   * have a writer in production source, or be listed as reserved-only WITH its
   * reason — there is no third state where the catalog and the code disagree
   * silently.
   */
  'should have a production writer for every key that is not explicitly reserved-only', () => {
    const sources = readProductionSources(SOURCE_ROOT).join('\n')
    const declaredOnly = new Set<string>(Object.keys(RESERVED_LOG_KEYS_NOT_EMITTED))

    // A writer references the key through the constant, e.g.
    // `RESERVED_LOG_KEYS.LOGGER_SHUTDOWN_OK`. Collected rather than asserted in
    // the loop so a failure names every dead key at once.
    const withoutWriter = Object.keys(RESERVED_LOG_KEYS).filter(
      (key) => !declaredOnly.has(key) && !sources.includes(`RESERVED_LOG_KEYS.${key}`)
    )

    expect(withoutWriter).toEqual([])
  })

  it(/*
   * The reserved-only map may only name keys that actually exist, and each must
   * carry a non-empty reason — an escape hatch without a justification would
   * just re-create the dead-key problem under a different name.
   */
  'should justify every reserved-only key against a real declaration', () => {
    for (const [key, reason] of Object.entries(RESERVED_LOG_KEYS_NOT_EMITTED)) {
      expect(Object.keys(RESERVED_LOG_KEYS)).toContain(key)
      expect(typeof reason).toBe('string')
      expect(reason.length).toBeGreaterThan(20)
    }
    expect(Object.isFrozen(RESERVED_LOG_KEYS_NOT_EMITTED)).toBe(true)
  })
})
