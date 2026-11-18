/**
 * The message of an error, censored where it opens the stack.
 *
 * Layer: server/utils — pure, no I/O. The first lines of a V8 stack are the name and the message of
 * the error, so a name in `redactPaths` that censors `message` leaves the same text readable in
 * `stack`, in the stack of each cause, and in the `exception.*` fields derived from them. The text
 * is replaced by an exact match, never by a pattern built from host text.
 */

/** What starts the line of a frame in a V8 stack: the first one ends the lines of the header. */
const FRAME_LINE = '\n    at '

/**
 * What starts a frame line in any stack the engine or a host may write: indentation, then `at `.
 * The indentation holds no newline, so a stack made of line breaks is searched in linear time.
 */
const ANY_FRAME_LINE = /\n[ \t]*at /

/**
 * Replace the message where it opens `stack`, once, by the text that censored it.
 *
 * V8 writes the name, a colon and the message, and then the first frame line, so the message is the
 * occurrence in the header that ends where the frames begin, or where a stack with no frame ends. It
 * is found by that and not by being first: an error whose name repeats its message, or whose message
 * is a part of its name, has an earlier occurrence that is not the message. A header written
 * another way (a custom stack formatter, a stack the host set, lines after the message) has no such
 * occurrence, and then the last occurrence in the header is the one censored, because showing the
 * message is the failure and censoring a little more is not. A stack that does not hold the message
 * at all, because it was changed after the engine wrote the stack, is returned as it is.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param stack - The text of the stack, as the engine wrote it.
 * @param message - The message as the error carries it.
 * @param censored - What the message became when it was censored.
 * @returns The stack with the header censored, or `stack` when nothing was censored or the header
 *   does not hold the message.
 */
export function censorStackHeader(stack: string, message: string, censored: string): string {
  if (message === '' || censored === message) return stack
  const at = headerOccurrence(stack, message)
  if (at === -1) return stack
  return stack.slice(0, at) + censored + stack.slice(at + message.length)
}

/**
 * Where the message starts in the header: the last occurrence that ends it, else the last occurrence
 * that starts no later than the first frame line.
 *
 * @param stack - The text of the stack.
 * @param message - The message.
 * @returns The index of that occurrence, or `-1` when the header holds none.
 */
function headerOccurrence(stack: string, message: string): number {
  const firstFrame = stack.search(ANY_FRAME_LINE)
  let ending = -1
  let last = -1
  for (let at = stack.indexOf(message); at !== -1; at = stack.indexOf(message, at + 1)) {
    if (firstFrame !== -1 && at > firstFrame) break
    last = at
    const end = at + message.length
    if (end === stack.length || stack.startsWith(FRAME_LINE, end)) ending = at
  }
  return ending === -1 ? last : ending
}
