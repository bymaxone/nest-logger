/**
 * The text of an `Error`'s stack, as the logger may write it.
 *
 * Layer: server/utils.
 */

import { withBinaryAsSizeForText } from './own-field-policy.util'

/** The engine's own rule for the first line of a stack: the name and the message as text. */
const ERROR_TO_STRING = Error.prototype.toString

/**
 * Read the stack of an error. The engine writes the name and the message into its first line as
 * text, so where either holds a binary value that text is replaced by the size. The frames are
 * kept only when the stack starts with that line; otherwise nothing of the stack is kept, since
 * where the line ends is not known.
 *
 * @param error - The error.
 * @returns The stack, or whatever `stack` holds when it is not a string.
 */
export function readStackText(error: Error): unknown {
  const stack: unknown = error.stack
  if (typeof stack !== 'string') return stack
  let sized: unknown
  let header: string
  try {
    sized = withBinaryAsSizeForText(error)
    if (sized === error) return stack
    header = ERROR_TO_STRING.call(error)
  } catch {
    // A name or a message that cannot be read leaves the stack as it is.
    return stack
  }
  const frames = stack.startsWith(header) ? stack.slice(header.length) : ''
  return `${String(sized)}${frames}`
}
