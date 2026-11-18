/**
 * The last step of the entry text of an object message: censored under the names of the field it
 * came from, then cut at `maxStringLength` when that is set, so the text is bounded as its field is.
 *
 * Layer: server/utils — pure, no I/O. The factory leaves a finisher on the Pino instance it builds,
 * under {@link ENTRY_TEXT_FINISHER}, and the logger service reads it. The finisher covers names
 * whatever the redaction strategy, because the text is a copy of a field that the strategy may
 * censor by path. A `Symbol` key, so it is not a property anyone can write by accident and not part
 * of the public API.
 */
import { cutText } from './bounded-text.util'
import type { Redactor } from './redact-by-name.util'

/**
 * That a text is cut at `maxStringLength`, as the text of an object message is, as its field is.
 * `emitted` says whether the entry is written: a cut of an entry that is not written is not counted.
 */
export interface EntryTextCut {
  readonly emitted: boolean
}

/**
 * Finishes the text that came from the member `key` of an object message, or the `message` of an
 * `Error`. Without a `cut` the text is censored and not cut, as the log message of an `Error` is,
 * because the option does not apply to it.
 */
export type EntryTextFinisher = (key: string, text: string, cut?: EntryTextCut) => string

/**
 * The key of the property on the Pino instance that holds the {@link EntryTextFinisher}: the
 * protocol between the factory that sets it and the logger service that reads it. Internal; it is
 * not exported from the package barrel.
 */
export const ENTRY_TEXT_FINISHER: unique symbol = Symbol('bymax.entryTextFinisher')

/**
 * The censor of a text under the name of the field it is a copy of, and nothing else: no cut and
 * no count.
 *
 * @param redact - A redactor that covers the names a consumer asked to censor.
 * @returns A function that never throws: text the redactor cannot censor, or turns into a value
 *   that is not text, becomes the empty string.
 */
export function createTextCensor(redact: Redactor): (key: string, text: string) => string {
  return (key, text) => {
    try {
      const censored: unknown = Reflect.get(redact({ [key]: text }, true) as object, key)
      return typeof censored === 'string' ? censored : ''
    } catch {
      return ''
    }
  }
}

/**
 * @param redact - A redactor that covers the names a consumer asked to censor.
 * @param limit - The configured `maxStringLength`, when there is one.
 * @param onCut - Called each time the text of an entry that is written is cut at `limit`, so the
 *   cuts can be counted.
 * @returns A finisher that never throws: text the redactor cannot censor, or turns into a value
 *   that is not text, becomes the empty string.
 */
export function createEntryTextFinisher(
  redact: Redactor,
  limit: number | undefined,
  onCut?: () => void
): EntryTextFinisher {
  const censor = createTextCensor(redact)
  return (key, text, cut) => {
    const censored = censor(key, text)
    if (limit === undefined || cut === undefined) return censored
    const cutOff = cutText(censored, false, limit)
    if (cut.emitted && cutOff !== censored) onCut?.()
    return cutOff
  }
}
