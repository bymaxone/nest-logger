import {
  LOG_CONTEXT_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN
} from './injection-tokens.constants'

describe('injection tokens', () => {
  it(/*
   * Every token must be a unique JavaScript Symbol so the NestJS DI graph
   * cannot collide them with provider tokens from other libraries.
   */
  'should expose every token as a Symbol', () => {
    expect(typeof LOGGER_OPTIONS_TOKEN).toBe('symbol')
    expect(typeof LOGGER_PINO_INSTANCE_TOKEN).toBe('symbol')
    expect(typeof LOGGER_DESTINATIONS_TOKEN).toBe('symbol')
    expect(typeof LOG_CONTEXT_TOKEN).toBe('symbol')
  })

  it(/*
   * Identity equality is a load-bearing contract: two consumers asking for
   * `LOGGER_OPTIONS_TOKEN` must resolve to the same provider.
   */
  'should preserve referential identity across re-imports', () => {
    expect(LOGGER_OPTIONS_TOKEN).toBe(LOGGER_OPTIONS_TOKEN)
    expect(LOGGER_PINO_INSTANCE_TOKEN).toBe(LOGGER_PINO_INSTANCE_TOKEN)
  })

  it(/*
   * Distinct tokens must not collide with each other — guards against an
   * accidental refactor that aliases two unrelated providers.
   */
  'should keep every token pair-wise distinct', () => {
    const tokens = [
      LOGGER_OPTIONS_TOKEN,
      LOGGER_PINO_INSTANCE_TOKEN,
      LOGGER_DESTINATIONS_TOKEN,
      LOG_CONTEXT_TOKEN
    ]
    const uniqueTokens = new Set(tokens)
    expect(uniqueTokens.size).toBe(tokens.length)
  })

  it(/*
   * Symbol descriptions are surfaced in NestJS error messages — keeping the
   * `BYMAX_LOGGER_*` prefix makes provider-not-found errors easy to grep.
   */
  'should carry a description prefixed with BYMAX_LOGGER', () => {
    expect(LOGGER_OPTIONS_TOKEN.description).toContain('BYMAX_LOGGER')
    expect(LOGGER_PINO_INSTANCE_TOKEN.description).toContain('BYMAX_LOGGER')
    expect(LOGGER_DESTINATIONS_TOKEN.description).toContain('BYMAX_LOGGER')
    expect(LOG_CONTEXT_TOKEN.description).toContain('BYMAX_LOGGER')
  })
})
