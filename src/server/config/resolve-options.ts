/**
 * The options of the module as the host gave them, read once, validated and given their defaults.
 *
 * Layer: server/config. The options are the host's objects: a getter or a Proxy of theirs can answer
 * differently each time it is read, so the values that pass the validator are the values the
 * defaults are made from.
 */
import { applyDefaults } from './default-options'
import { dropUnsetOptions } from './drop-unset-options'
import { guardOptions } from './options-refusal.util'
import { validateOptions } from './validate-options'
import type {
  BymaxLoggerModuleOptions,
  ResolvedBymaxLoggerModuleOptions
} from '../interfaces/logger-module-options.interface'
import { pinoBuiltinsIntact } from '../utils/captured-builtins.util'

/**
 * Read the options once into a plain snapshot, validate that snapshot and apply the defaults to it.
 * A read that throws ends in the refusal of {@link guardOptions}; a refusal of the validator passes
 * unchanged.
 *
 * @param given - The options as the host supplied them.
 * @returns The frozen, fully-defaulted options.
 * @throws Error When an option fails validation or cannot be read.
 */
export function resolveOptions(given: BymaxLoggerModuleOptions): ResolvedBymaxLoggerModuleOptions {
  // The options are read with built-in methods; one replaced would answer for them.
  if (!pinoBuiltinsIntact()) throw new Error('LOGGER_BUILTINS_REPLACED')
  return guardOptions(() => {
    const snapshot = dropUnsetOptions(given)
    validateOptions(snapshot)
    return applyDefaults(snapshot)
  })
}
