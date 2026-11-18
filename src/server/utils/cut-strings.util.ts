/**
 * The cut that `maxStringLength` applies, as a final pass over a record the redaction walk has
 * already written.
 *
 * Layer: server/utils — pure, no I/O, no imports beyond the text cut shared with the message cap.
 *
 * The pass runs after every censor, so it cannot cut a string before a rule that needs the whole
 * of it (a sensitive header name inside `rawHeaders`, an error-like object under `err`) has read
 * it. What it reads is the walk's own output: plain objects and arrays it built, markers for a
 * cycle or an exhausted budget, and `Error` instances kept as they are. It needs none of the
 * hostile-input care the walk has, which is why it is a separate function and not a branch of
 * the walk.
 */
import { cutText } from './bounded-text.util'
import { isPlainRecord } from './is-plain-record.util'

/**
 * `node` with every string in it cut at `limit`; what is not text, an array or plain data is kept.
 * `onCut` is called once for each string that was cut.
 */
function cutNode(node: unknown, limit: number, onCut: (() => void) | undefined): unknown {
  if (typeof node === 'string') {
    const cut = cutText(node, false, limit)
    if (cut !== node) onCut?.()
    return cut
  }
  if (Array.isArray(node)) return node.map((child: unknown) => cutNode(child, limit, onCut))
  if (isPlainRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, cutNode(child, limit, onCut)])
    )
  }
  return node
}

/**
 * Cut every string of `record` at `limit` characters, except under the root keys in `exempt`.
 *
 * A cut string keeps its first `limit` characters, never splitting a surrogate pair, and ends
 * with the marker the message cap uses. A key is never cut, and neither is a value that is not
 * text. A root key in `exempt` is returned as it is and is not entered.
 *
 * @internal NOT re-exported by the package barrel.
 * @param record - The record the redaction walk wrote.
 * @param limit - The most characters a string keeps.
 * @param exempt - Root keys whose value is left whole.
 * @param onCut - Called once for each string that was cut, so the cuts can be counted.
 * @returns A new record; `record` is not changed.
 */
export function cutStrings(
  record: Readonly<Record<string, unknown>>,
  limit: number,
  exempt: ReadonlySet<string>,
  onCut?: () => void
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      exempt.has(key) ? child : cutNode(child, limit, onCut)
    ])
  )
}
