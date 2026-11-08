/**
 * Pins `resolveNameRedactor` and `resolveRedactOption`: which redactor the options select.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
import { resolveNameRedactor, resolveRedactOption } from './pino-factory'
import { LogContextService } from './services/log-context.service'
import { buildPinoInstance, createCapture, baseOptions } from './__tests__/pino-factory.fixtures'

describe('resolveNameRedactor', () => {
  /** Probe payload: a secret nested past the legacy four-level ceiling. */
  const deep = { l1: { l2: { l3: { l4: { l5: { password: 'secret' } } } } } }

  it(/*
   * The default configuration must return a REAL redactor. This is the switch
   * that decides whether default PII protection exists at all, so it is asserted
   * directly — an output-level assertion cannot tell "the walk censored it" from
   * "fast-redact censored it".
   */
  'returns an active redactor under the default configuration', () => {
    const redact = resolveNameRedactor(applyDefaults(baseOptions))
    expect(redact(deep)).not.toBe(deep)
    expect(JSON.stringify(redact(deep))).not.toContain('secret')
  })

  it(/*
   * `shouldDisableDefaultRedact` must turn the walk off too — the opt-out has to
   * disable the DEFAULT engine whichever engine that currently is.
   */
  'returns a pass-through when the default set is disabled', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ ...baseOptions, shouldDisableDefaultRedact: true })
    )
    expect(redact(deep)).toBe(deep)
  })

  it(/*
   * Both switches off together must still be a pass-through — pins the OR, which
   * an AND mutant would turn into "walk stays on unless BOTH are set".
   */
  'returns a pass-through when both opt-outs are set', () => {
    const redact = resolveNameRedactor(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths', shouldDisableDefaultRedact: true })
    )
    expect(redact(deep)).toBe(deep)
  })
})

it(/*
 * REGRESSION — consumer `redactPaths` are applied by Pino's stringifier, which
 * runs AFTER the serializer wrapper. A field covered only by a path was still
 * raw when the size bound built its 200-character `_preview`, so an oversized
 * value leaked its secret there. The path's LEAF NAME now reaches the walk.
 */
'keeps a consumer-path field out of an oversized value preview', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      maxEntrySizeBytes: 60,
      redactPaths: ['blob.ssn'],
      serializers: { blob: (value: unknown): unknown => value }
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ blob: { ssn: 'SECRET-123', filler: 'x'.repeat(400) } }, 'x')

  const blob = capture.entries()[0]?.['blob'] as Record<string, unknown>
  expect(blob['_truncated']).toBe(true)
  expect(String(blob['_preview'])).toContain('[REDACTED]')
  expect(String(blob['_preview'])).not.toContain('SECRET')
})

it(/*
 * The leaf name is taken from bracket syntax too, which is how `fast-redact`
 * spells a key that is not a bare identifier.
 */
'reads the leaf name out of a bracketed consumer path', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({ ...baseOptions, redactPaths: ['req.headers["x-custom-token"]'] }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ elsewhere: { 'x-custom-token': 'secret' } }, 'x')

  const elsewhere = capture.entries()[0]?.['elsewhere'] as Record<string, unknown>
  expect(elsewhere['x-custom-token']).toBe('[REDACTED]')
})

it(/*
 * REGRESSION — end to end for a dotted key: the consumer declares
 * `blob["social.security"]` secret, and the walk must match that exact name, so
 * the value stays out of an oversized field's truncation preview.
 */
'covers a bracketed key containing a dot', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      maxEntrySizeBytes: 60,
      redactPaths: ['blob["social.security"]'],
      serializers: { blob: (value: unknown): unknown => value }
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ blob: { 'social.security': 'SECRET-123', filler: 'x'.repeat(400) } }, 'x')

  const blob = capture.entries()[0]?.['blob'] as Record<string, unknown>
  expect(blob['_truncated']).toBe(true)
  expect(String(blob['_preview'])).toContain('[REDACTED]')
  expect(String(blob['_preview'])).not.toContain('SECRET')
})
it(/*
 * With the defaults disabled, a consumer path's leaf name is still honoured —
 * the opt-out drops the library's set, not the consumer's own declaration.
 */
'honors consumer path names when the default set is disabled', () => {
  const capture = createCapture()
  const logger = buildPinoInstance(
    applyDefaults({
      ...baseOptions,
      shouldDisableDefaultRedact: true,
      redactPaths: ['*.ssn']
    }),
    new LogContextService(),
    [capture.destination]
  )

  logger.info({ user: { ssn: 'secret', password: 'by-design' } }, 'x')

  const user = capture.entries()[0]?.['user'] as Record<string, unknown>
  expect(user['ssn']).toBe('[REDACTED]')
  expect(user['password']).toBe('by-design')
})

describe('resolveRedactOption', () => {
  it(/*
   * Under the default strategy with no consumer paths, `fast-redact` must not be
   * configured AT ALL. This is the ~100× difference the engine change bought,
   * and it is invisible in the serialized output — both configurations censor
   * the same fields — so it can only be asserted here.
   */
  'omits the Pino redact option entirely under the default configuration', () => {
    expect(resolveRedactOption(applyDefaults(baseOptions))).toBeUndefined()
  })

  it(/*
   * Consumer paths are always `fast-redact` paths, so they MUST be forwarded —
   * and under `'names'` they must be forwarded ALONE, without the default
   * expansion the walk already covers.
   */
  'forwards only the consumer paths under the default strategy', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactPaths: ['*.ssn', '*.ssn'] })
    )
    expect(option).toEqual({ paths: ['*.ssn'], censor: '[REDACTED]' })
  })

  it(/*
   * The legacy strategy must hand Pino the full default expansion — that IS the
   * legacy engine. Asserted on the path count so a mutant that quietly drops the
   * defaults cannot pass.
   */
  'forwards the full default expansion under the legacy paths strategy', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactStrategy: 'paths', redactPaths: ['*.ssn'] })
    )
    expect(option?.paths).toContain('*.ssn')
    expect(option?.paths).toContain('*.*.*.*.password')
    expect(option?.paths).toHaveLength(DEFAULT_REDACT_PATHS.length + 1)
  })

  it(/*
   * Legacy strategy with the defaults disabled: only the consumer paths survive,
   * and an empty set means no redact option at all.
   */
  'honors shouldDisableDefaultRedact under the legacy strategy', () => {
    expect(
      resolveRedactOption(
        applyDefaults({
          ...baseOptions,
          redactStrategy: 'paths',
          shouldDisableDefaultRedact: true
        })
      )
    ).toBeUndefined()
  })

  it(/*
   * A custom censor must reach the `fast-redact` config, not just the walk.
   */
  'carries the configured censor into the redact option', () => {
    const option = resolveRedactOption(
      applyDefaults({ ...baseOptions, redactPaths: ['*.ssn'], redactCensor: '***' })
    )
    expect(option?.censor).toBe('***')
  })
})
