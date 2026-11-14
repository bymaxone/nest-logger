/**
 * Default deadlines of the destination lifecycle, in milliseconds, shared by option resolution and
 * option validation so the two cannot disagree about what an omitted value means.
 */

/** Longest `onInit` or `onRegistryReady` of a destination. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000

/** Total shutdown budget, covering the drain and every `onShutdown`. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/** Longest the shutdown drain may take. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5000
