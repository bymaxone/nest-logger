/**
 * The part of the name walk that leaves the `message` of the object under `err` to the serializer
 * of `err`, which censors it in its own output and in the stack header the walk would have replaced
 * beforehand.
 *
 * Layer: server/utils. Pure.
 */
import { cutIfText } from './bounded-text.util'
import { hideMessageInStack } from './hide-message-in-stack.util'
import type { RedactRules } from './redact-by-name.util'
import { ERROR_TEXT_FIELDS } from './redact-error-parts.util'
import { censorName } from './sanitize-error.util'

/** The name `message`, which the serializer of `err` censors: the stack header is built from it. */
const ERROR_TEXT_KEYS: ReadonlySet<string> = new Set(['message'])

/**
 * Whether the value under `key` is not a list, for the serializer of `err`. A value that holds no keys
 * (text, a number, `null`) is walked as it was, and a function is walked as an object is.
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
  return rules.errorTextToSerializer && !honorToJson && key === 'err' && !Array.isArray(value)
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

/**
 * The censor of a text as the name `message` is for these rules: the censor when the name is one to
 * hide, the text otherwise.
 *
 * @param rules - The rules of the walk.
 * @returns The function the name of an error passes through.
 */
export function messageCensor(rules: RedactRules): (text: string) => string {
  return (text) => (rules.sensitive.has('message') ? rules.censor : text)
}

/**
 * The message of an object that is no `Error` and carries a `message` and a `stack` of its own, when
 * the rules hide `message` and the object is not the one under `err` (whose message the serializer
 * censors): the text the header of its stack is a copy of. Read once, here, so the walk uses the same
 * text for the field and for the header.
 *
 * @param rules - The rules of the walk.
 * @param source - The object being walked.
 * @param keys - Its own enumerable keys.
 * @param isError - Whether it is an `Error`.
 * @returns The message, or `undefined` when there is no header to hide it in.
 */
export function headerMessage(
  rules: RedactRules,
  source: object,
  keys: readonly string[],
  isError: boolean
): string | undefined {
  if (isError || !rules.sensitive.has('message') || rules.exemptKeys?.has('message') === true)
    return undefined
  if (!keys.includes('message') || !keys.includes('stack')) return undefined
  const message: unknown = Reflect.get(source, 'message')
  return typeof message === 'string' ? message : undefined
}

/**
 * The value of a field as the walk reads it: the message already read for the header, so the field
 * and the header are made from one read, and any other field by property access.
 *
 * @param source - The object being walked.
 * @param key - The field.
 * @param message - What {@link headerMessage} read, if anything.
 * @returns The value of the field.
 */
export function readField(source: object, key: string, message: string | undefined): unknown {
  return key === 'message' && message !== undefined ? message : Reflect.get(source, key)
}

/**
 * A text field of an `Error` as the walk writes it: cut at the text limit, and, for the `name`,
 * censored as the name of the `err` of an entry is.
 *
 * @param rules - The rules of the walk.
 * @param key - The field: `name`, `message` or `stack`.
 * @param value - Its value.
 * @param isError - Whether the object holding the field is an `Error` the walk reads.
 * @param message - The message of an object that is no `Error`, whose `stack` header holds it.
 * @returns The value to write.
 */
export function errorTextField(
  rules: RedactRules,
  key: string,
  value: unknown,
  isError: boolean,
  message?: string
): unknown {
  if (message !== undefined && key === 'stack' && typeof value === 'string') {
    return hideMessageInStack(value, message, rules.censor)
  }
  if (!isError || !ERROR_TEXT_FIELDS.has(key)) return value
  const cut = cutIfText(value)
  return key === 'name' && typeof cut === 'string' ? censorName(cut, messageCensor(rules)) : cut
}
