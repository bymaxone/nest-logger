/**
 * The part of the name walk that leaves the `message` of the object under `err` to the serializer
 * of `err`, which censors it in its own output and in the stack header the walk would have replaced
 * beforehand.
 *
 * Layer: server/utils. Pure.
 */
import type { RedactRules } from './redact-by-name.util'

/** The name `message`, which the serializer of `err` censors: the stack header is built from it. */
const ERROR_TEXT_KEYS: ReadonlySet<string> = new Set(['message'])

/**
 * Whether the value under `key` is an object, not a list, for the serializer of `err`.
 *
 * @param rules - The rules of the walk.
 * @param key - The key the value is under.
 * @param value - The value.
 * @param honorToJson - `false` only for the root of a log record.
 */
function leavesErrorText(
  rules: RedactRules,
  key: string,
  value: unknown,
  honorToJson: boolean
): boolean {
  return (
    rules.errorTextToSerializer &&
    !honorToJson &&
    key === 'err' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/**
 * The rules for the value under `key`: the exemption holds for the object under `err` only.
 *
 * @param rules - The rules of the walk.
 * @param key - The key the value is under.
 * @param value - The value.
 * @param honorToJson - `false` only for the root of a log record.
 * @returns The rules the value is walked with.
 */
export function rulesBelow(
  rules: RedactRules,
  key: string,
  value: unknown,
  honorToJson: boolean
): RedactRules {
  if (leavesErrorText(rules, key, value, honorToJson)) {
    return { ...rules, exemptKeys: ERROR_TEXT_KEYS }
  }
  // Stryker disable next-line ConditionalExpression: equivalent: a copy with no exemption walks as the rules do, so this branch only saves the allocation.
  return rules.exemptKeys === undefined ? rules : { ...rules, exemptKeys: undefined }
}

/**
 * Whether the walk censors the value under `key`: a sensitive name, except the `message` of the
 * object under `err` when it is text, which the serializer censors.
 *
 * @param rules - The rules of the walk.
 * @param key - The key the value is under.
 * @param value - The value.
 * @returns `true` to write the censor in place of the value.
 */
export function isCensored(rules: RedactRules, key: string, value: unknown): boolean {
  const lower = key.toLowerCase()
  return rules.sensitive.has(lower) && !(typeof value === 'string' && rules.exemptKeys?.has(lower))
}
