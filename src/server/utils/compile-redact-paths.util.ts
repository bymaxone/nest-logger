/**
 * Redact-path compilation utility.
 *
 * Layer: server/utils — a pure helper that merges consumer-supplied redact
 * paths with the library defaults before passing the combined list to the Pino
 * factory. Deduplication is mandatory because `fast-redact` throws on duplicate
 * paths.
 */
import { DEFAULT_REDACT_PATHS } from '../constants/default-redact-paths.constants'

/**
 * Compile the final list of redact paths passed to Pino's `redact.paths`.
 *
 * Behavior:
 *   - When `shouldSkipDefaults === true` → returns the deduplicated
 *     `extraPaths` only. Consumers opting out of the canonical PII
 *     protection take full responsibility for their own redact config.
 *   - Otherwise → returns the union of `DEFAULT_REDACT_PATHS` and
 *     `extraPaths`, deduplicated. Deduplication is critical because
 *     `fast-redact` (the engine under `pino.redact`) throws on duplicate
 *     paths.
 *
 * @param extraPaths — Consumer-supplied additional redact paths.
 * @param shouldSkipDefaults — Skip the library defaults when true. Mirrors
 *   the consumer-facing `shouldDisableDefaultRedact` flag without leaking the
 *   public-API name into the helper signature.
 * @returns A flat, deduplicated `string[]` ready for `pino.redact.paths`.
 */
export function compileRedactPaths(
  extraPaths: readonly string[],
  shouldSkipDefaults: boolean
): string[] {
  const sources = shouldSkipDefaults ? [extraPaths] : [DEFAULT_REDACT_PATHS, extraPaths]
  return Array.from(new Set(sources.flat()))
}
