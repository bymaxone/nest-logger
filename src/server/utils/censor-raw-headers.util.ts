/**
 * Censoring of the values in a `rawHeaders` array, which no key can reach.
 *
 * Layer: server/utils — a pure helper of the name-based redaction walk. Node keeps the headers of a
 * message twice: as `headers`, an object the walk censors by key, and as `rawHeaders`, a flat array
 * `[name, value, name, value, ...]` where a value is beside its name and not under it.
 */

/**
 * The `rawHeaders` array with the value of each sensitive header replaced by the censor.
 *
 * @param raw - The alternating names and values.
 * @param sensitive - The lower-cased names whose values are censored.
 * @param censor - The replacement written in place of a value.
 * @returns A new array; names and the values of other headers are unchanged.
 */
export function censorRawHeaders(
  raw: readonly unknown[],
  sensitive: ReadonlySet<string>,
  censor: unknown
): unknown[] {
  return raw.map((entry, index) => {
    const name = index % 2 === 1 ? raw[index - 1] : undefined
    return typeof name === 'string' && sensitive.has(name.toLowerCase()) ? censor : entry
  })
}
