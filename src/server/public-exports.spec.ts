/**
 * Pins the symbols the README documents as importable from the package root.
 *
 * Layer: server, tests. `check:published` proves a documented snippet compiles against the
 * built package; this holds the runtime values themselves, so a symbol dropped from the
 * barrel fails here before it reaches a build.
 */
import * as root from './index'
import {
  DEFAULT_REDACT_PATHS,
  REDACT_COMMON_FIELDS
} from './constants/default-redact-paths.constants'
import { LOGGER_REDACTOR_TOKEN } from './constants/injection-tokens.constants'
import { isValidTraceId } from './utils/otel-detector'

describe('package root exports', () => {
  it(/*
   * The redactor token is the injection point of the exported PinoLoggerService's redactor, so a
   * consumer composing its own providers has to be able to name the same symbol.
   */
  'exports LOGGER_REDACTOR_TOKEN as the same symbol the service injects', () => {
    expect(root.LOGGER_REDACTOR_TOKEN).toBe(LOGGER_REDACTOR_TOKEN)
    expect(typeof root.LOGGER_REDACTOR_TOKEN).toBe('symbol')
  })

  it(/*
   * Extending the defaults by reference only works if the exported list is the one the
   * redactor uses, not a copy that can drift from it.
   */
  'exports REDACT_COMMON_FIELDS as the list DEFAULT_REDACT_PATHS is built from', () => {
    expect(root.REDACT_COMMON_FIELDS).toBe(REDACT_COMMON_FIELDS)
    expect(root.DEFAULT_REDACT_PATHS).toBe(DEFAULT_REDACT_PATHS)
    expect(root.REDACT_COMMON_FIELDS).toContain('password')
  })

  it(/*
   * The helper is the one the trace mixin applies, so a consumer validating an id gets the
   * same verdict the library would.
   */
  'exports isValidTraceId with the mixin’s rule', () => {
    expect(root.isValidTraceId).toBe(isValidTraceId)
    expect(root.isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true)
    expect(root.isValidTraceId('0'.repeat(32))).toBe(false)
    expect(root.isValidTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false)
  })

  it(/*
   * Every token is a Symbol and no two collide: a shared symbol would make one provider
   * answer for another.
   */
  'exports five distinct injection tokens, each a symbol', () => {
    const tokens = [
      root.LOGGER_OPTIONS_TOKEN,
      root.LOGGER_PINO_INSTANCE_TOKEN,
      root.LOGGER_DESTINATIONS_TOKEN,
      root.LOGGER_REDACTOR_TOKEN,
      root.LOG_CONTEXT_TOKEN
    ]
    expect(tokens.every((token) => typeof token === 'symbol')).toBe(true)
    expect(new Set(tokens).size).toBe(5)
  })
})
