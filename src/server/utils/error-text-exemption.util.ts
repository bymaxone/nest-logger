/**
 * The part of the name walk that leaves the `message` of the object under `err` to the serializer
 * of `err`, which censors it in its own output and in the stack header the walk would have replaced
 * beforehand.
 *
 * Layer: server/utils. Pure.
 */
import { cutIfText } from './bounded-text.util'
import { foldKey, foldName } from './fold-key.util'
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
  return rules.exemptKeys === undefined && rules.headerKept !== true
    ? rules
    : { ...rules, exemptKeys: undefined, headerKept: undefined }
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
  const folded = foldName(key)
  return (
    rules.sensitive.has(folded) && !(typeof value === 'string' && rules.exemptKeys?.has(folded))
  )
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

/** What the header of a stack is a copy of: each message as it was read, by the key it was read from. */
export interface HeaderText {
  /** The text of every own key that spells `message`, each read once. */
  readonly texts: ReadonlyMap<string, string>
}

/**
 * The message of an object that is no `Error` and carries a `message` and a `stack` of its own, when
 * the rules hide `message` and the object is not the one under `err` (whose message the serializer
 * censors): the text the header of its stack is a copy of. The keys are matched as the spellings of
 * one name are, so `Message` and `STACK` count, and every key that spells `message` is read, since the
 * header may be a copy of any of them. Each is read once, here, so the walk uses the same text for the
 * field and for the header.
 *
 * @param rules - The rules of the walk.
 * @param source - The object being walked.
 * @param keys - Its own enumerable keys.
 * @param isError - Whether it is an `Error`.
 * @returns The messages by their keys, or `undefined` when there is no header to hide them in.
 */
export function headerMessage(
  rules: RedactRules,
  source: object,
  keys: readonly string[],
  isError: boolean
): HeaderText | undefined {
  if (isError || !rules.sensitive.has('message') || rules.exemptKeys?.has('message') === true)
    return undefined
  if (rules.headerKept === true) return undefined
  const keysOf = (name: string): string[] => keys.filter((candidate) => foldKey(candidate) === name)
  if (keysOf('stack').length === 0) return undefined
  const texts = new Map<string, string>()
  for (const key of keysOf('message')) {
    const text: unknown = Reflect.get(source, key)
    if (typeof text === 'string') texts.set(key, text)
  }
  return texts.size === 0 ? undefined : { texts }
}

/**
 * The value of a field as the walk reads it: the message already read for the header, so the field
 * and the header are made from one read, and any other field by property access.
 *
 * @param source - The object being walked.
 * @param key - The field.
 * @param header - What {@link headerMessage} read, if anything.
 * @returns The value of the field.
 */
export function readField(source: object, key: string, header: HeaderText | undefined): unknown {
  return header?.texts.get(key) ?? Reflect.get(source, key)
}

/**
 * The name of an error as the censor of the message leaves it: text passes the censor of names, a
 * value that is an object or a function may hold anything and is hidden with the message, and any
 * other value is kept.
 *
 * @param rules - The rules of the walk.
 * @param name - The name, of any type.
 * @returns The name to write.
 */
export function censorAnyName(rules: RedactRules, name: unknown): unknown {
  if (typeof name === 'string') return censorName(name, messageCensor(rules))
  const holder = (typeof name === 'object' && name !== null) || typeof name === 'function'
  return holder && rules.sensitive.has('message') ? rules.censor : name
}

/**
 * A text field of an `Error` as the walk writes it: cut at the text limit, and, for the `name`,
 * censored as the name of the `err` of an entry is.
 *
 * @param rules - The rules of the walk.
 * @param key - The field: `name`, `message` or `stack`.
 * @param value - Its value.
 * @param isError - Whether the object holding the field is an `Error` the walk reads.
 * @param header - The message of an object that is no `Error`, whose `stack` header holds it.
 * @returns The value to write.
 */
export function errorTextField(
  rules: RedactRules,
  key: string,
  value: unknown,
  isError: boolean,
  header?: HeaderText
): unknown {
  if (header !== undefined && foldKey(key) === 'stack' && typeof value === 'string') {
    return [...new Set(header.texts.values())]
      .sort((a, b) => b.length - a.length)
      .reduce((stack, text) => hideMessageInStack(stack, text, rules.censor), value)
  }
  if (!isError || !ERROR_TEXT_FIELDS.has(key)) return value
  const cut = cutIfText(value)
  return key === 'name' ? censorAnyName(rules, cut) : cut
}
