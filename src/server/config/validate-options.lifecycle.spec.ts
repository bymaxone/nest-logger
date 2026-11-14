/**
 * Validation of the lifecycle deadlines by `validateOptions`, and how the defaults resolve.
 *
 * Layer: server/config, tests. A deadline is handed to a timer, which reads a value above
 * 2147483647 as 1 and fires at once, so the bound is checked where the option enters.
 */
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

import { applyDefaults } from './default-options'
import { validateOptions } from './validate-options'

const base: BymaxLoggerModuleOptions = { service: { name: 'app', version: '1.0.0' } }

/** Build options with an untyped extra key, as plain JS would. */
const withOption = (key: string, value: unknown): BymaxLoggerModuleOptions =>
  ({ ...base, [key]: value }) as BymaxLoggerModuleOptions

describe('validateOptions: lifecycle deadlines', () => {
  it.each([
    ['destinationHookTimeoutMs', 1],
    ['destinationHookTimeoutMs', 2_147_483_647],
    ['shutdown', { timeoutMs: 2_147_483_647, drainTimeoutMs: 2_147_483_647 }],
    ['shutdown', { timeoutMs: 100, drainTimeoutMs: 100 }],
    ['shutdown', { drainTimeoutMs: 4000 }],
    ['shutdown', {}]
  ])('accepts %s = %j', (key, value) => {
    expect(() => validateOptions(withOption(key, value))).not.toThrow()
  })

  it.each([
    ['destinationHookTimeoutMs', 0],
    ['destinationHookTimeoutMs', -1],
    ['destinationHookTimeoutMs', 1.5],
    ['destinationHookTimeoutMs', 2_147_483_648],
    ['destinationHookTimeoutMs', '1000'],
    ['destinationHookTimeoutMs', Number.NaN],
    ['destinationHookTimeoutMs', Number.POSITIVE_INFINITY]
  ])('rejects %s = %j, naming the option', (key, value) => {
    expect(() => validateOptions(withOption(key, value))).toThrow(
      /options\.destinationHookTimeoutMs must be an integer from 1 to 2147483647/
    )
  })

  it.each([
    [{ timeoutMs: 0 }, 'shutdown.timeoutMs'],
    [{ timeoutMs: 2_147_483_648 }, 'shutdown.timeoutMs'],
    [{ drainTimeoutMs: -5 }, 'shutdown.drainTimeoutMs'],
    [{ drainTimeoutMs: 0.5 }, 'shutdown.drainTimeoutMs']
  ])('rejects shutdown %j, naming %s', (value, path) => {
    expect(() => validateOptions(withOption('shutdown', value))).toThrow(
      new RegExp(`options\\.${path.replace('.', '\\.')} must be an integer from 1 to 2147483647`)
    )
  })

  it('rejects a shutdown group that is not an object', () => {
    expect(() => validateOptions(withOption('shutdown', 5000))).toThrow(
      /options\.shutdown must be an object/
    )
  })

  it('refuses a drain longer than the total it is part of', () => {
    expect(() =>
      validateOptions(withOption('shutdown', { timeoutMs: 1000, drainTimeoutMs: 1001 }))
    ).toThrow(/options\.shutdown\.drainTimeoutMs must not exceed shutdown\.timeoutMs/)
  })

  it('refuses a drain above the default total when only the drain is given', () => {
    expect(() => validateOptions(withOption('shutdown', { drainTimeoutMs: 20_000 }))).toThrow(
      /options\.shutdown\.drainTimeoutMs must not exceed shutdown\.timeoutMs/
    )
  })

  it('does not refuse a short total because of a drain default the consumer never set', () => {
    expect(() => validateOptions(withOption('shutdown', { timeoutMs: 2000 }))).not.toThrow()
  })
})

describe('applyDefaults: lifecycle deadlines', () => {
  it('resolves the documented defaults', () => {
    const resolved = applyDefaults(base)

    expect(resolved.destinationHookTimeoutMs).toBe(10_000)
    expect(resolved.shutdown).toEqual({ timeoutMs: 10_000, drainTimeoutMs: 5000 })
  })

  it('keeps the values the consumer gave', () => {
    const resolved = applyDefaults({
      ...base,
      destinationHookTimeoutMs: 250,
      shutdown: { timeoutMs: 900, drainTimeoutMs: 400 }
    })

    expect(resolved.destinationHookTimeoutMs).toBe(250)
    expect(resolved.shutdown).toEqual({ timeoutMs: 900, drainTimeoutMs: 400 })
  })

  it('caps the default drain to a short total, and freezes the group', () => {
    const resolved = applyDefaults({ ...base, shutdown: { timeoutMs: 2000 } })

    expect(resolved.shutdown).toEqual({ timeoutMs: 2000, drainTimeoutMs: 2000 })
    expect(Object.isFrozen(resolved.shutdown)).toBe(true)
  })
})
