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
 * Replace every occurrence of `message` in the header of `stack`, by `replacement`. The header is
 * everything before the first frame that does not lie inside the message: the first occurrence of the
 * message that starts before a frame-shaped line decides where the header ends, and an occurrence
 * that starts at or after that line is the text of a frame, which stays.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The text of the message the stack opens with, which may span lines.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when the header does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  const first = stack.indexOf(message)
  if (message === '' || first === -1) return stack
  const frame = stack.search(FIRST_FRAME)
  if (frame !== -1 && first >= frame) return stack
  const after = first + message.length
  const next = stack.slice(after).search(FIRST_FRAME)
  const end = next === -1 ? stack.length : after + next
  return stack.slice(0, end).replaceAll(message, replacement) + stack.slice(end)
}
