/**
 * The refusal of an accessor planted on `Object.prototype`.
 *
 * Layer: server/utils. Pino merges the options it is handed with `Object.assign({}, …)`, which sets each
 * value on a plain object: an inherited setter discards a value the library set, and an inherited getter
 * answers in its place, such as a `formatters.log` that returns the record as it is. No option can
 * prevent that, so the logger is not built while one stands.
 */
import { refuse } from '../config/options-refusal.util'

/**
 * Refuse the build when `Object.prototype` holds an accessor, other than the `__proto__` it has natively.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @throws Error Naming the key, when one is planted.
 */
export function refusePlantedAccessors(): void {
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    const { get, set } = Object.getOwnPropertyDescriptor(Object.prototype, key) ?? {}
    if (key !== '__proto__' && (get || set)) {
      refuse(
        `[BymaxLoggerModule] the logger is not built while Object.prototype holds an accessor: "${key}"`
      )
    }
  }
}
