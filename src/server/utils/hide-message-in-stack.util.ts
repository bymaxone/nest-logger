/**
 * The header of a stack with the text of a message replaced.
 *
 * Layer: server/utils. Pure. The stack of an object that is no error to the library opens with the
 * text of its own `message`, which the options hide in the `message` field; the header of the stack
 * is a copy of it, and is hidden the same way. The frames below it are the stack's own text.
 */

/** A line that begins, after white space, with `at `: the start of a frame, or a line of a message that looks like one. */
const FRAME_LINE = /\n[ \t]+at /g

/** A `[start, end)` span of a stack. */
type Span = readonly [number, number]

/**
 * The length of the longest proper prefix of `message[0..i]` that is also its suffix, for each `i`:
 * the table a search of a text for the message reads to go on after a mismatch without going back.
 */
function failureTable(message: string): Int32Array {
  const table = new Int32Array(message.length)
  // Stryker disable next-line EqualityOperator: equivalent: at `i === message.length` the loop only shrinks `matched` and writes past the end of a typed array, which stores nothing.
  for (let i = 1, matched = 0; i < message.length; i += 1) {
    while (matched > 0 && message[i] !== message[matched]) matched = table[matched - 1] as number
    if (message[i] === message[matched]) matched += 1
    table[i] = matched
  }
  return table
}

/**
 * The spans where `message` occurs in `stack`, in order, in one pass over the stack whatever the
 * message is. Occurrences that overlap are one span, so a message that overlaps itself is hidden whole.
 */
function occurrences(stack: string, message: string): Span[] {
  const table = failureTable(message)
  const spans: Array<[number, number]> = []
  // Stryker disable next-line EqualityOperator: equivalent: at `i === stack.length` no character is read, `matched` falls below the length of the message and no occurrence is added.
  for (let i = 0, matched = 0; i < stack.length; i += 1) {
    while (matched > 0 && stack[i] !== message[matched]) matched = table[matched - 1] as number
    if (stack[i] === message[matched]) matched += 1
    if (matched === message.length) {
      const start = i + 1 - message.length
      const last = spans[spans.length - 1]
      if (last !== undefined && start < last[1]) last[1] = i + 1
      else spans.push([start, i + 1])
    }
  }
  return spans
}

/**
 * Where the header ends: the first frame-shaped line that lies outside every span. Both lists are in
 * order, so one pass over them is enough, however many lines the message itself holds.
 */
function headerEnd(stack: string, spans: readonly Span[]): number {
  let next = 0
  for (const line of stack.matchAll(FRAME_LINE)) {
    while (next < spans.length && (spans[next] as Span)[1] <= line.index) next += 1
    const span = spans[next]
    if (span === undefined || line.index < span[0]) return line.index
  }
  return stack.length
}

/**
 * Replace the occurrences of `message` in the header of `stack` by `replacement`. The header ends at
 * the first frame-shaped line that lies outside every occurrence of the message, so a message of
 * several lines, one that holds a frame-shaped line, one that repeats and one that overlaps itself
 * are all hidden, while an occurrence after that line is the text of a frame and stays.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The text of the message the stack opens with, which may span lines.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when the header does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  if (message === '') return stack
  // Stryker disable next-line ConditionalExpression: equivalent in output: a message that does not fit in the stack is not found in it; the return only spares the table, which is as long as the message.
  if (message.length > stack.length) return stack
  const spans = occurrences(stack, message)
  const end = headerEnd(stack, spans)
  let result = ''
  let from = 0
  for (const [start, stop] of spans.filter(([, stop]) => stop <= end)) {
    result += stack.slice(from, start) + replacement
    from = stop
  }
  return result + stack.slice(from)
}
