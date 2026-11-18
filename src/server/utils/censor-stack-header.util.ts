/**
 * The message of an error, censored where it opens the stack.
 *
 * Layer: server/utils — pure, no I/O. The first lines of a V8 stack are the name and the message of
 * the error, so a name in `redactPaths` that censors `message` leaves the same text readable in
 * `stack`, in the stack of each cause, and in the `exception.*` fields derived from them. The text
 * is replaced by an exact match, never by a pattern built from host text.
 */
import { isPlainRecord } from './is-plain-record.util'

/** What starts the line of a frame in a V8 stack: the first one ends the lines of the header. */
const FRAME_LINE = '\n    at '

/**
 * Replace the message where it opens `stack`, once, by the text that censored it.
 *
 * Only an occurrence that starts at or before the first frame line is the header, so a message that
 * a frame repeats is not touched there, and a message that holds the text of a frame line still is. A message that was changed after the error was built is not found, because the
 * stack kept the one it was built with, and the stack is returned as it is.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param stack - The text of the stack.
 * @param message - The message as the error carries it.
 * @param censored - What the message became when it was censored.
 * @returns The stack with the header censored, or `stack` when nothing was censored or the message
 *   does not open it.
 */
export function censorStackHeader(stack: string, message: string, censored: string): string {
  if (message === '' || censored === message) return stack
  const at = stack.indexOf(message)
  const firstFrame = stack.indexOf(FRAME_LINE)
  if (at === -1 || (firstFrame !== -1 && at > firstFrame)) return stack
  return stack.slice(0, at) + censored + stack.slice(at + message.length)
}

/**
 * The stacks of a serialized error and of its causes, with the header censored wherever the
 * message was.
 *
 * `raw` is the node as the serializer wrote it and `redacted` is the same node after the redaction
 * walk: a message that differs between the two was censored, and its text is censored in the stack
 * of that node. The causes and the aggregated errors are paired by position, and a part the walk
 * replaced by a marker is left as it is.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param raw - A node of the serializer output, before redaction.
 * @param redacted - The same node, after redaction.
 * @returns `redacted`, or a copy of it with the stacks censored.
 */
export function censorErrorStacks(raw: unknown, redacted: unknown): unknown {
  if (!isPlainRecord(raw) || !isPlainRecord(redacted)) return redacted
  const copy: Record<string, unknown> = { ...redacted }
  const { message } = raw
  const censored = redacted['message']
  const written = redacted['stack']
  if (typeof message === 'string' && typeof censored === 'string' && typeof written === 'string') {
    copy['stack'] = censorStackHeader(written, message, censored)
  }
  if ('cause' in redacted) copy['cause'] = censorErrorStacks(raw['cause'], redacted['cause'])
  const members = redacted['errors']
  const rawMembers = raw['errors']
  if (Array.isArray(members) && Array.isArray(rawMembers)) {
    copy['errors'] = members.map((member: unknown, index) =>
      censorErrorStacks(rawMembers[index], member)
    )
  }
  return copy
}
