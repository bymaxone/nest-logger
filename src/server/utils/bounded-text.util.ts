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
 * {@link cutText} for a value that is a string, and the value itself for anything else. A thrown
 * value can carry any type where the type system says `string`, and a logging path must not throw
 * because of what an error holds.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param value - A field that is usually text.
 * @returns The cut text, or `value` unchanged when it is not a string.
 */
export function cutIfText(value: unknown): unknown {
  return typeof value === 'string' ? cutText(value) : value
}

/**
 * Cut `text` at `limit` characters when it is longer, or when `alreadyCut` says it is the
 * start of something longer, and append {@link TEXT_TRUNCATED}. A cut that falls between the two
 * halves of a surrogate pair drops the first half, so the result is well-formed text.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param text - The text to bound.
 * @param alreadyCut - `true` when `text` is the part of a longer text that was read.
 * @param limit - The most characters kept; {@link MAX_TEXT_LENGTH} when not given.
 * @returns The text, or its first `limit` characters followed by {@link TEXT_TRUNCATED}.
 */
export function cutText(text: string, alreadyCut = false, limit = MAX_TEXT_LENGTH): string {
  if (!alreadyCut && text.length <= limit) return text
  const head = text.slice(0, limit)
  const last = head.charCodeAt(head.length - 1)
  const whole = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
  return whole + TEXT_TRUNCATED
}

/**
 * A text cut so that its UTF-8 form is at most `maxBytes`, marker included, at a character boundary.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param text - The text.
 * @param maxBytes - The most UTF-8 bytes the result may have.
 * @returns `text` when it fits, else its longest whole-character prefix that leaves room for
 *   {@link TEXT_TRUNCATED}, followed by it; when the ceiling cannot hold the marker, the longest
 *   whole-character prefix that fits, with no marker.
 */
export function cutBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(TEXT_TRUNCATED, 'utf-8')
  const marked = maxBytes >= markerBytes
  const bytes = Buffer.from(text, 'utf-8')
  let end = Math.min(marked ? maxBytes - markerBytes : maxBytes, bytes.length)
  // A continuation byte (10xxxxxx) starts nothing: step back to the byte that starts the character.
  // `end` is below `bytes.length`: the text is over the ceiling, so the byte at `end` exists.
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf-8') + (marked ? TEXT_TRUNCATED : '')
}
