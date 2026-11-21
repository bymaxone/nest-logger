/**
 * The header of a stack with the text of a message replaced.
 *
 * Layer: server/utils. Pure. The stack of an object that is no error to the library opens with the
 * text of its own `message`, which the options hide in the `message` field; the header of the stack
 * is a copy of it, and is hidden the same way. The frames below it are the stack's own text.
 */

/** A line that begins, after white space, with `at `: the start of a frame, or a line of a message that looks like one. */
const FRAME_LINE = /\n[ \t]+at /g

/** The `[start, end)` span of each non-overlapping occurrence of `message` in `stack`. */
function occurrences(stack: string, message: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (
    let at = stack.indexOf(message);
    at !== -1;
    at = stack.indexOf(message, at + message.length)
  ) {
    spans.push([at, at + message.length])
  }
  return spans
}

/**
 * Replace the occurrences of `message` in the header of `stack` by `replacement`. The header ends at
 * the first frame-shaped line that lies outside every occurrence of the message, so a message of
 * several lines, one that holds a frame-shaped line, and one that repeats are all hidden, while an
 * occurrence after that line is the text of a frame and stays.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The text of the message the stack opens with, which may span lines.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when the header does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  if (message === '') return stack
  const spans = occurrences(stack, message)
  const frame = [...stack.matchAll(FRAME_LINE)].find(
    (line) => !spans.some(([start, end]) => line.index >= start && line.index < end)
  )
  const headerEnd = frame === undefined ? stack.length : frame.index
  let result = ''
  let from = 0
  for (const [start, end] of spans.filter(([, end]) => end <= headerEnd)) {
    result += stack.slice(from, start) + replacement
    from = end
  }
  return result + stack.slice(from)
}
