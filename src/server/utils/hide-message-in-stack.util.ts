/**
 * The header of a stack with the text of a message replaced.
 *
 * Layer: server/utils. Pure. The stack of an object that is no error to the library opens with the
 * text of its own `message`, which the options hide in the `message` field; the header of the stack
 * is a copy of it, and is hidden the same way. The frames below it are the stack's own text.
 */

/** The start of the first frame: a line that begins, after white space, with `at `. */
const FIRST_FRAME = /\n[ \t]+at /

/**
 * Replace every occurrence of `message` in the header of `stack`, which is everything before the first
 * frame, by `replacement`.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The text of the message the stack opens with, which may span lines.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when the header does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  const end = stack.search(FIRST_FRAME)
  const header = end === -1 ? stack : stack.slice(0, end)
  if (message === '' || !header.includes(message)) return stack
  return header.replaceAll(message, replacement) + stack.slice(header.length)
}
