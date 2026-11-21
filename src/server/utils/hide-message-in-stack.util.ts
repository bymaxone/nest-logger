/**
 * The text of a message replaced wherever a stack holds it.
 *
 * Layer: server/utils. Pure. The stack of an object that is no error to the library opens with the
 * text of its own `message`, which the options hide in the `message` field; the stack is a copy of it
 * where it opens and wherever a library repeats it (`Caused by: ...`), and every copy is hidden the
 * same way.
 */

/** A `[start, end)` span of a stack. */
type Span = readonly [number, number]

/**
 * The length of the longest proper prefix of `message[0..i]` that is also its suffix, for each `i`:
 * the table a search of a text for the message reads to go on after a mismatch without going back.
 */
function failureTable(message: string): Int32Array {
  const table = new Int32Array(message.length)
  // Stryker disable next-line EqualityOperator: equivalent: at `i === message.length` there is no character, so the loop only shrinks `matched` and then writes past the end of the typed array, which stores nothing, and the table is read only below the length of the message.
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
  // Stryker disable next-line EqualityOperator: equivalent: at `i === stack.length` there is no character, so `matched` can only fall, or pass the length of the message when the last character ended an occurrence, and a count past that length is not a match: no span is added.
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
 * The first `limit` characters of `stack`, with every occurrence of each of `messages` replaced by
 * `replacement`: in the header, in a message of several lines, in a message that holds a frame-shaped
 * line, that repeats or that overlaps itself, and in the lines below, where a library may repeat it.
 * An occurrence that starts before `limit` is replaced whole, and the text ends where it ends, so no
 * part of a message is left at the end; an occurrence that starts at or after `limit` is not read.
 * Each message is searched in one pass over the stack, whatever it is.
 *
 * @param stack - The stack as the caller wrote it, read up to `limit` plus the longest message.
 * @param messages - The messages to hide, which may span lines.
 * @param replacement - What the censor makes of a message.
 * @param limit - How much of the stack, counted in its own characters, the result stands for.
 * @returns That part of the stack, unchanged where it holds no message.
 */
export function hideMessagesInStack(
  stack: string,
  messages: readonly string[],
  replacement: string,
  limit: number
): string {
  const spans = messages
    // Stryker disable next-line ConditionalExpression: equivalent in output: a message that does not fit in the stack is not found in it; the test only spares the table, which is as long as the message.
    .filter((message) => message !== '' && message.length <= stack.length)
    .flatMap((message) => occurrences(stack, message))
    .sort((a, b) => a[0] - b[0])
  let result = ''
  let from = 0
  let end = limit
  for (const [start, stop] of spans) {
    if (start >= end) break
    if (start < from) {
      from = Math.max(from, stop)
      end = Math.max(end, from)
      continue
    }
    result += stack.slice(from, start) + replacement
    from = stop
    end = Math.max(end, stop)
  }
  return result + stack.slice(from, Math.max(end, from))
}

/**
 * Replace every occurrence of `message` in `stack` by `replacement`.
 *
 * @param stack - The stack as the caller wrote it.
 * @param message - The message the stack opens with, which may span lines.
 * @param replacement - What the censor makes of the message.
 * @returns The stack, unchanged when it does not hold the message.
 */
export function hideMessageInStack(stack: string, message: string, replacement: string): string {
  return hideMessagesInStack(stack, [message], replacement, stack.length)
}
