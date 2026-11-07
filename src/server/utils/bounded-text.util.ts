/**
 * The length of the text the logger writes.
 *
 * Layer: server/utils. A stack and a message are text the logger copies from a value it does not
 * own, and the engine can build one hundreds of megabytes long (the stack header of an error whose
 * `name` and `message` are themselves errors stringifies them), so each is written at most
 * {@link MAX_TEXT_LENGTH} characters long and ends with {@link TEXT_TRUNCATED} when it was cut.
 */

/** Longest stack or message written to an entry, in characters. */
export const MAX_TEXT_LENGTH = 16_384

/** Appended to a text that was cut at {@link MAX_TEXT_LENGTH}. */
export const TEXT_TRUNCATED = '…[truncated]'

/**
 * Cut `text` at {@link MAX_TEXT_LENGTH} when it is longer, or when `alreadyCut` says it is the
 * start of something longer, and append {@link TEXT_TRUNCATED}. A cut that falls between the two
 * halves of a surrogate pair drops the first half, so the result is well-formed text.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param text - The text to bound.
 * @param alreadyCut - `true` when `text` is the part of a longer text that was read.
 * @returns The text, or its first {@link MAX_TEXT_LENGTH} characters followed by
 *   {@link TEXT_TRUNCATED}.
 */
export function cutText(text: string, alreadyCut = false): string {
  if (!alreadyCut && text.length <= MAX_TEXT_LENGTH) return text
  const head = text.slice(0, MAX_TEXT_LENGTH)
  const last = head.charCodeAt(head.length - 1)
  const whole = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
  return whole + TEXT_TRUNCATED
}
