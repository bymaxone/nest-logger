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

/** Default bound of the entries one destination may hold queued, in bytes (32 MiB). */
export const DEFAULT_QUEUE_MAX_BYTES = 33_554_432

/** Smallest nonzero queue bound; below it a single large entry could never be accepted. */
export const MIN_QUEUE_MAX_BYTES = 1024

/** Largest queue bound, the largest signed 32-bit integer. */
export const MAX_QUEUE_MAX_BYTES = 2_147_483_647
