/**
 * The first line of a stack with the text of a message replaced.
 *
 * Layer: server/utils. Pure. The stack of an object that is no error to the library opens with the
 * text of its own `message`, which the options hide in the `message` field; the first line of the
 * stack is a copy of it, and is hidden the same way. The frames below it are the stack's own text.
 */

/**
 * Replace the first occurrence of `message` in the first line of `stack` by `replacement`.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The text of the message the stack opens with.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when the first line does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  const end = stack.indexOf('\n')
  const first = end === -1 ? stack : stack.slice(0, end)
  const at = message === '' ? -1 : first.indexOf(message)
  if (at === -1) return stack
  return (
    first.slice(0, at) + replacement + first.slice(at + message.length) + stack.slice(first.length)
  )
}
