/**
 * The line between a refusal of the library and an error of the host while the options of the module
 * are read.
 *
 * Layer: server/config. The options are the host's objects: a getter or a Proxy of theirs can throw
 * at any read. Such an error must not leave the library as it is, since the host's own text would
 * then stand where the library's message should; it is refused with a message of the library and
 * kept as its cause. The library's own refusals are told apart by a mark kept in a `WeakSet`, which
 * runs no trap of the value it is asked about and cannot be forged by a host, and the mark is used
 * once, so an error the host catches and throws again is no longer taken for the library's. Because
 * the mark is used once, a guard must not run inside another one.
 */

/** The errors the library created to refuse an option, that have not been passed on yet. */
const refusals = new WeakSet<object>()

/** The message of the refusal for an option that could not be read. */
const UNREADABLE = '[BymaxLoggerModule] options could not be read'

/**
 * Refuse an option with a message of the library.
 *
 * @param message - The message, which starts with `[BymaxLoggerModule]`.
 * @throws Error Always, marked as the library's own.
 */
export function refuse(message: string): never {
  const error = new Error(message)
  refusals.add(error)
  throw error
}

/**
 * Run a read of the options: a refusal of the library passes as it is, and any other error is refused
 * with a message of the library and the error as its cause.
 *
 * @param read - The read, which validates and resolves the options.
 * @returns What the read returns.
 * @throws Error The refusal of the library, or {@link UNREADABLE} with the host's error as cause.
 */
export function guardOptions<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (typeof error === 'object' && error !== null && refusals.delete(error)) throw error
    throw new Error(UNREADABLE, { cause: error })
  }
}
