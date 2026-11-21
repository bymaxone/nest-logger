/**
 * The part of the name walk that leaves the `message` of the object under `err` to the serializer
 * of `err`, which censors it in its own output and in the stack header the walk would have replaced
 * beforehand.
 *
 * Layer: server/utils. Pure.
 */
import { cutIfText, MAX_TEXT_LENGTH } from './bounded-text.util'
import { foldKey, matchesFolded, matchesKey } from './fold-key.util'
import { hideMessagesInStack } from './hide-message-in-stack.util'
import type { RedactRules } from './redact-by-name.util'
import { ERROR_TEXT_FIELDS } from './redact-error-parts.util'
import { censorName, MAX_STACK_SCAN, scrubStack } from './sanitize-error.util'

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
  return (
    matchesKey(rules.sensitive, key) && !(typeof value === 'string' && rules.exemptKeys?.has(key))
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

/** Whether `key` spells `stack`, however it is written. */
export const isStackKey = (key: string): boolean => matchesKey(STACK_NAMES, key)

/** The folded names the stack and the message of an object are looked for under. */
const STACK_NAMES: ReadonlySet<string> = new Set(['stack'])
const MESSAGE_NAMES: ReadonlySet<string> = new Set(['message'])

/** The most distinct messages, and the most keys that spell `stack`, one object may make the walk search for. */
export const MAX_STACK_ALIASES = 8

/** What the walk knows of the stack keys of an object that is no `Error`. */
export interface HeaderText {
  /** The text of every own key that spells `message`, each read once; empty unless the options hide `message`. */
  readonly texts: ReadonlyMap<string, string>
  /** The own keys that spell `stack`, which the walk writes as the stack of the object. */
  readonly stackKeys: ReadonlySet<string>
  /** The object has more distinct messages or more stack keys than the walk searches for: every stack is hidden whole. */
  readonly overflow: boolean
}

/** What an object with no stack key has: nothing to write as a stack. */
const NO_STACK: HeaderText = { texts: new Map(), stackKeys: new Set(), overflow: false }

/**
 * What the walk needs to write the stack keys of an object that is no `Error` and carries one: the
 * messages its stacks are a copy of when the options hide `message` and the object is not the one
 * under `err` (whose message the serializer censors), and whether it carries more of either than a
 * search can be bounded for. The keys are matched as the spellings of one name are, so `Message` and
 * `STACK` count, and every key that spells `message` is read, since a header may be a copy of any of
 * them. Each is read once, here, so the walk uses the same text for the field and for the header.
 *
 * @param rules - The rules of the walk.
 * @param source - The object being walked.
 * @param keys - Its own enumerable keys.
 * @param isError - Whether it is an `Error`.
 * @returns The plan: nothing to write for an object with no stack key; for an `Error`, the plan of its own
 *   enumerable keys that spell `stack`, and `undefined` when it has none.
 */
export function headerMessage(
  rules: RedactRules,
  source: object,
  keys: readonly string[],
  isError: boolean
): HeaderText | undefined {
  const keysOf = (names: ReadonlySet<string>): string[] =>
    keys.filter((candidate) => matchesKey(names, candidate))
  // An own key of an `Error` that spells `stack`, `stack` itself included, is a copy of the message.
  const stacks = keysOf(STACK_NAMES)
  if (stacks.length === 0) return isError ? undefined : NO_STACK
  const hides =
    rules.sensitive.has('message') &&
    (isError || (rules.exemptKeys?.has('message') !== true && rules.headerKept !== true))
  const texts = new Map<string, string>()
  if (hides) {
    for (const key of keysOf(MESSAGE_NAMES)) {
      const text: unknown = Reflect.get(source, key)
      if (typeof text === 'string') texts.set(key, text)
    }
    // The message by its own name too, whether or not it is an own enumerable key: the header of a
    // stack is a copy of it all the same.
    const named: unknown = keys.includes('message') ? undefined : Reflect.get(source, 'message')
    if (typeof named === 'string') texts.set('message', named)
  }
  // A message longer than the text limit is never searched for: the part of the stack read is bounded by
  // the limit and not by the message, so a stack that may repeat it is written as the censor.
  const overflow =
    stacks.length > MAX_STACK_ALIASES ||
    new Set(texts.values()).size > MAX_STACK_ALIASES ||
    [...texts.values()].some((text) => text.length > MAX_TEXT_LENGTH)
  return { texts, stackKeys: new Set(stacks), overflow }
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
 * The `stack` of an object that is no `Error`, as the stack of an error is written: read up to the
 * scan bound, every copy of the message hidden when the options hide it, dependency frames dropped,
 * control characters escaped and the text cut, with the suffix when anything was.
 *
 * @param rules - The rules of the walk.
 * @param stack - The text of the stack.
 * @param header - The messages of the object, when the options hide `message`.
 * @returns The text to write.
 */
function scrubPlainStack(
  rules: RedactRules,
  stack: string,
  header: HeaderText | undefined
): string {
  const texts = [...new Set(header?.texts.values())]
  const longest = texts.reduce((most, text) => Math.max(most, text.length), 0)
  // The part searched reaches as far past the bound as the longest message is long, so a message that
  // starts before the bound is found whole: what is kept after the messages are hidden and the dependency
  // frames dropped can reach past the bound, so a copy cut by the bound would leave its start in the text.
  const hidden = hideMessagesInStack(
    stack.slice(0, MAX_STACK_SCAN + longest),
    texts,
    rules.censor,
    MAX_STACK_SCAN
  )
  return scrubStack(hidden, undefined, stack.length > MAX_STACK_SCAN)
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
  const isStack =
    typeof value === 'string' &&
    (header === undefined ? !isError && matchesKey(STACK_NAMES, key) : header.stackKeys.has(key))
  if (isStack) {
    return header?.overflow === true ? rules.censor : scrubPlainStack(rules, value, header)
  }
  if (!isError || !ERROR_TEXT_FIELDS.has(key)) return value
  const cut = cutIfText(value)
  return key === 'name' ? censorAnyName(rules, cut) : cut
}
