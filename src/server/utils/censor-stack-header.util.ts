/**
 * The message of an error, censored where it opens the stack.
 *
 * Layer: server/utils — pure, no I/O. The first lines of a V8 stack are the name and the message of
 * the error, so a name in `redactPaths` that censors `message` leaves the same text readable in
 * `stack`, in the stack of each cause, and in the `exception.*` fields derived from them. The
 * message is looked for at the one place the engine writes it, and nowhere else.
 */

/** What separates the name from the message in the first line of a stack. */
const NAME_SEPARATOR = ': '

/**
 * Whether the message sits at `from` and ends there: a line break or the end of the stack follows it.
 * That is the header, even when the message holds lines that look like frames.
 *
 * @param stack - The text of the stack.
 * @param message - The message.
 * @param from - Where the message would start.
 * @returns `true` when the message is the header from `from` on.
 */
function endsHeader(stack: string, message: string, from: number): boolean {
  const end = from + message.length
  return stack.startsWith(message, from) && (end === stack.length || stack.startsWith('\n', end))
}

/**
 * Split `stack` into its header, with the message replaced by the text that censored it, and what
 * follows the header: the lines of the stack.
 *
 * The engine writes the name, `: `, the message, and then the first frame line, so the message sits
 * right after the first `: ` of the first line, or at the start when the error has no name. One
 * comparison at each of those places decides, and only the message is replaced. A header that is not
 * in that form is not read at all: the header is the name of the error, `: ` and the censored
 * message, built from the values at hand with nothing of the text of the stack in it, and the frames
 * are dropped, because what such a header holds may be the secret too and no search for it can be
 * shown to find it. A message that was not censored changes nothing, and an empty one has nothing to
 * hide.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param stack - The text of the stack, as the engine wrote it.
 * @param name - The name of the error, empty when it has none.
 * @param message - The message as the error carries it.
 * @param censored - What the message became when it was censored.
 * @returns The header and the rest of the stack; the rest is empty when the frames were dropped.
 */
export function splitCensoredHeader(
  stack: string,
  name: string,
  message: string,
  censored: string
): readonly [string, string] {
  if (message === '' || censored === message) return ['', stack]
  const separator = stack.indexOf(NAME_SEPARATOR)
  // The separator of the first line: no line break comes before it.
  if (separator !== -1 && stack.lastIndexOf('\n', separator) === -1) {
    const from = separator + NAME_SEPARATOR.length
    if (endsHeader(stack, message, from)) {
      return [stack.slice(0, from) + censored, stack.slice(from + message.length)]
    }
  }
  if (endsHeader(stack, message, 0)) return [censored, stack.slice(message.length)]
  return [name === '' ? censored : name + NAME_SEPARATOR + censored, '']
}

/**
 * Replace the message in the header of `stack` by the text that censored it.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param stack - The text of the stack, as the engine wrote it.
 * @param name - The name of the error, empty when it has none.
 * @param message - The message as the error carries it.
 * @param censored - What the message became when it was censored.
 * @returns The stack with the header censored, or `stack` when the message was not censored.
 */
export function censorStackHeader(
  stack: string,
  name: string,
  message: string,
  censored: string
): string {
  return splitCensoredHeader(stack, name, message, censored).join('')
}
