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
 * where the line ends is not known. No stack is answered either where that line cannot be built,
 * or where the text would not end.
 *
 * @param error - The error.
 * @param onSized - Called when the first line was replaced.
 * @returns The stack, whatever `stack` holds when it is not a string, or `undefined`.
 */
export function readStackText(error: Error, onSized?: () => void): unknown {
  const stack: unknown = error.stack
  if (typeof stack !== 'string') return stack
  let sized: unknown
  try {
    sized = withBinaryAsSizeForText(error)
  } catch (failure) {
    // A name or a message that cannot be read leaves the stack as it is. One whose text would not
    // end was not looked through, so what the engine wrote of it is not written.
    return failure instanceof RangeError ? undefined : stack
  }
  if (sized === error) return stack
  let header: string
  try {
    header = ERROR_TO_STRING.call(error)
  } catch {
    // The first line holds a binary value and where it ends cannot be known.
    return undefined
  }
  const frames = stack.startsWith(header) ? stack.slice(header.length) : ''
  const text = `${String(sized)}${frames}`
  onSized?.()
  return text
}
