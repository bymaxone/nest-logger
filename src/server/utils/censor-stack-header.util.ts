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
 * The most occurrences of the message that are examined in a header. An engine writes the message
 * once; a header that holds more is one nobody wrote as a stack, and walking every occurrence of a
 * message that overlaps itself costs the product of the two lengths.
 */
const MAX_OCCURRENCES = 64

/** What {@link headerOccurrence} answers when the header holds no occurrence of the message. */
const NOT_FOUND = -1

/** What {@link headerOccurrence} answers when the header holds more occurrences than are examined. */
const TOO_MANY = -2

/**
 * Replace the message where it opens `stack`, once, by the text that censored it.
 *
 * V8 writes the name, a colon and the message, and then the first frame line, so the message is the
 * occurrence in the header that ends where the frames begin, or where a stack with no frame ends. It
 * is found by that and not by being first: an error whose name repeats its message, or whose message
 * is a part of its name, has an earlier occurrence that is not the message. A header written
 * another way (a custom stack formatter, a stack the host set, lines after the message) has no such
 * occurrence, and then the last occurrence in the header is the one censored, because showing the
 * message is the failure and censoring a little more is not; so a message that was changed after the
 * engine wrote the stack, and is a part of the older header text, is censored there. A header that
 * holds more than {@link MAX_OCCURRENCES} occurrences is censored whole, and a header that holds none
 * is returned as it is.
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
  const firstFrame = stack.search(ANY_FRAME_LINE)
  const at = headerOccurrence(stack, message, firstFrame)
  if (at === NOT_FOUND) return stack
  if (at === TOO_MANY) return censored + stack.slice(firstFrame === -1 ? stack.length : firstFrame)
  return stack.slice(0, at) + censored + stack.slice(at + message.length)
}

/**
 * Where the message starts in the header: the last occurrence that ends it, else the last occurrence
 * that starts no later than the first frame line.
 *
 * @param stack - The text of the stack.
 * @param message - The message.
 * @param firstFrame - Where the first frame line starts, or `-1` when there is none.
 * @returns The index of that occurrence, {@link NOT_FOUND} when the header holds none, or
 *   {@link TOO_MANY} when it holds more than are examined.
 */
function headerOccurrence(stack: string, message: string, firstFrame: number): number {
  let ending = NOT_FOUND
  let last = NOT_FOUND
  let examined = 0
  for (let at = stack.indexOf(message); at !== -1; at = stack.indexOf(message, at + 1)) {
    if (firstFrame !== -1 && at > firstFrame) break
    examined += 1
    if (examined > MAX_OCCURRENCES) return TOO_MANY
    last = at
    const end = at + message.length
    if (end === stack.length || stack.startsWith(FRAME_LINE, end)) ending = at
  }
  return ending === NOT_FOUND ? last : ending
}
