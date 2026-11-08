/**
 * Pins what `resolveNameRedactor` returns when Pino's own path redaction is configured but censors
 * no name through the walk: a copy that is walked for binary values alone, and the pass-through
 * only when nothing is configured at all.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { resolveNameRedactor } from './pino-factory'

const baseOptions = { service: { name: 'app', version: '1.0.0' } }

describe('resolveNameRedactor when path redaction is configured', () => {
  /** Probe payload: a secret nested past the legacy four-level ceiling. */
  const deep = { l1: { l2: { l3: { l4: { l5: { password: 'secret' } } } } } }

  it(/*
   * The legacy `'paths'` strategy leaves the censoring of names to `fast-redact`, so the walk it
   * gets censors none: it returns an equal copy of the record. It is still a walk, because
   * `fast-redact` cannot read a `Buffer` and would throw out of the log call.
   */
  'returns a copy that censors no name under the legacy paths strategy', () => {
    const redact = resolveNameRedactor(applyDefaults({ ...baseOptions, redactStrategy: 'paths' }))
    expect(redact(deep)).not.toBe(deep)
    expect(redact(deep)).toEqual(deep)
  })

  it(/*
   * A path with no nameable segment yields no leaf, and with the defaults off that leaves no name
   * for the walk to match. Pino's own path redaction is still configured by those paths, and it
   * cannot read a `Buffer`, so the record is walked for binary alone and censors nothing.
   */
  'returns a copy that censors nothing when no path yields a leaf name and defaults are off', () => {
    const redact = resolveNameRedactor(
      applyDefaults({
        ...baseOptions,
        shouldDisableDefaultRedact: true,
        redactPaths: ['*', '*.*']
      })
    )
    const input = { password: 'kept', error: new Error('kept') }
    expect(redact(input)).not.toBe(input)
    expect(redact(input)).toEqual(input)
    expect((redact(input) as typeof input).error).toBeInstanceOf(Error)
  })

  it(/*
   * With the defaults off and no path at all, nothing redacts the record and nothing reads it, so
   * the pass-through stays: there is no Pino redaction for a `Buffer` to break.
   */
  'returns a pass-through when the defaults are off and no path is configured', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ ...baseOptions, shouldDisableDefaultRedact: true })
    )
    const input = { password: 'kept', buf: Buffer.from('ab') }
    expect(redact(input)).toBe(input)
  })
})
