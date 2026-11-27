/**
 * NestJS logger service backed by Pino 10.
 *
 * Layer: server/services — the injectable consumers receive via `@InjectLogger`
 * or `app.useLogger()`. It implements the official NestJS
 * `LoggerService` contract (variadic methods) AND a structured API that follows
 * the `MODULE_ACTION_RESULT` log-key convention.
 *
 * The variadic methods type their parameters as `unknown` rather than `any`:
 * `unknown` is assignment-compatible with the `any`-typed `LoggerService`
 * signatures while keeping the file free of explicit `any` (project lint rule).
 *
 * The structured API currently covers `info` / `warn` (via `info` /
 * `warnStructured`) and `error` (via `errorStructured`). Structured `debug` /
 * `fatal` helpers are intentionally out of scope until a consumer needs them.
 */
import { Inject, Injectable } from '@nestjs/common'
import type { LoggerService as NestLoggerService, OnApplicationShutdown } from '@nestjs/common'
import type { Logger as PinoLogger } from 'pino'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import {
  LOGGER_PINO_INSTANCE_TOKEN,
  LOGGER_REDACTOR_TOKEN
} from '../constants/injection-tokens.constants'
import { PROTOTYPE_POLLUTING_KEYS } from '../constants/prototype-polluting-keys.constants'
import { bareDescriptor } from '../utils/bare-descriptor.util'
import { cutText, MAX_TEXT_LENGTH } from '../utils/bounded-text.util'
import { capturedSet, lowerCase, pinoBuiltinsIntact } from '../utils/captured-builtins.util'
import { createEntryTextFinisher, ENTRY_TEXT_FINISHER } from '../utils/entry-text-finisher.util'
import type { EntryTextCut, EntryTextFinisher } from '../utils/entry-text-finisher.util'
import { isStackKey, MAX_STACK_ALIASES } from '../utils/error-text-exemption.util'
import { toBoundedMessage } from '../utils/escape-log-text.util'
import { foldKey } from '../utils/fold-key.util'
import { hideMessagesInStack } from '../utils/hide-message-in-stack.util'
import { isPlainRecord } from '../utils/is-plain-record.util'
import type { Redactor } from '../utils/redact-by-name.util'
import { isErrorLike } from '../utils/sanitize-error.util'

/** Pino level methods the NestJS-style variadic path dispatches to (error is handled separately). */
type PinoLevelMethod = 'info' | 'warn' | 'debug' | 'trace' | 'fatal'

/**
 * Field names the structured payload OWNS. A caller's `metadata` may never
 * occupy one: `userId` and `context` identify who acted and where, so a metadata
 * bag that could land in them would let a call site forge the attribution the
 * mixin reads from the authenticated AsyncLocalStorage scope — Pino merges the
 * caller's object OVER the mixin's, so a forged `userId` would win.
 *
 * This invariant used to be enforced by writing the reserved fields
 * unconditionally after the spread, which also wrote `undefined` and clobbered
 * the ALS value. Now the fields are written only when defined, so the invariant
 * has to be enforced on the way in instead.
 */
const OWNED_PAYLOAD_KEYS: readonly string[] = ['logKey', 'userId', 'context']

/**
 * The keys Pino writes itself, ahead of the payload: the level, the time, the message and the
 * resource of the service and its deployment. A payload that repeats one is written as a SECOND key of the same name,
 * and a reader that keeps the last one of a repeated key sees the caller's value, so a caller could
 * forge the level or the service of its own entry. The flat resource format writes `service.*` and
 * `deployment.environment.name`.
 */
const ENTRY_STRUCTURE_KEYS: readonly string[] = ['level', 'time', 'msg', 'service', 'deployment']

/**
 * The dotted keys of the flat resource format, owned by their spellings too: `service_name` and
 * `service-name` are the key `service.name` for a backend that folds separators. A key that only
 * starts with `service` or `deployment` is not owned, so `service_tier` is the caller's.
 */
const RESOURCE_KEYS: readonly string[] = [
  'service.name',
  'service.version',
  'service.namespace',
  'service.instance.id',
  'deployment.environment.name'
]

/**
 * The owned keys by their folded form (see {@link foldKey}), so a spelling of one (`Level`,
 * `log_key`, `USERID`) is dropped like the key itself.
 */
const OWNED_KEY_SPELLINGS: ReadonlySet<string> = capturedSet(
  [...OWNED_PAYLOAD_KEYS, ...ENTRY_STRUCTURE_KEYS, ...RESOURCE_KEYS].map((key) => foldKey(key))
)

/**
 * The keys the library derives from an error and writes on an entry itself. They are matched as they
 * look ({@link foldKey} with the separators kept) and not folded further: `exceptionType` is a name a
 * caller may use for a field of its own. `event.name` is not among them: a call with no log key may supply it.
 */
const DERIVED_KEYS: ReadonlySet<string> = capturedSet([
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'error.type'
])

/** Whether `key` is an owned key or a spelling of one, or one of the dotted resource keys. */
const isOwnedKey = (key: string): boolean => {
  const lower = lowerCase(key)
  return (
    OWNED_KEY_SPELLINGS.has(foldKey(key)) ||
    DERIVED_KEYS.has(foldKey(key, true)) ||
    lower.startsWith('service.') ||
    lower.startsWith('deployment.')
  )
}

/**
 * Copy `metadata` without the keys the structured payload owns.
 *
 * A {@link PROTOTYPE_POLLUTING_KEYS} entry is dropped along with them. `__proto__`
 * is an own key on anything that came from `JSON.parse`, and `Reflect.set` does
 * NOT create an own property for it: the write walks the prototype chain, finds
 * `Object.prototype`'s inherited `__proto__` SETTER and invokes it, so the field
 * vanished from the entry AND the copy's prototype was swapped for the caller's
 * value. Dropping it mirrors the guard the ALS path already enforced, from the
 * same constant so the two cannot drift.
 *
 * @param metadata - Caller-supplied structured fields, possibly `undefined`.
 * @param omit - One more key to leave out, used to keep an object message's text from being
 *   written twice.
 * @returns A shallow copy with every {@link OWNED_PAYLOAD_KEYS}, {@link ENTRY_STRUCTURE_KEYS} and
 *   {@link PROTOTYPE_POLLUTING_KEYS} entry dropped.
 */
function withoutOwnedKeys(
  metadata: Record<string, unknown> | undefined,
  omit?: string
): Record<string, unknown> {
  if (metadata === undefined) {
    return {}
  }
  try {
    const safe: Record<string, unknown> = {}
    for (const key of Object.keys(metadata)) {
      if (key !== omit && !isOwnedKey(key) && !PROTOTYPE_POLLUTING_KEYS.has(key)) {
        // `Reflect` keeps the dynamic read/write off the object-injection sink list.
        Reflect.set(safe, key, Reflect.get(metadata, key))
      }
    }
    return safe
  } catch {
    // Reading the caller's metadata can throw before anything reaches the
    // redactor: `Object.keys` runs a Proxy's `ownKeys` trap and `Reflect.get`
    // runs a getter. The redaction pipeline promises never to crash the request
    // that produced a log, and that promise has to start at the FIRST read of
    // caller-controlled data, not at the formatter. Metadata that cannot be read
    // cannot be proven safe, so it is dropped whole and marked — the entry still
    // carries its real `logKey`, message and correlation ids.
    return {
      _redactionFailed: true,
      _logKey: RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
    }
  }
}

/**
 * Read `error.message` without letting a hostile getter escape.
 *
 * `message` is an ordinary property that a caller can redefine as a throwing
 * accessor, and it is read OUTSIDE the serializer — straight into Pino's message
 * argument — so it needs its own guard.
 *
 * @param error - The error being logged.
 * @returns The message pinned to one line, or a fixed stand-in when it cannot be read.
 */
function safeErrorMessage(error: Error): string {
  try {
    return toBoundedMessage(String(error.message))
  } catch {
    return 'Unreadable error message'
  }
}

/** The entry text of an object message and the member it came from. */
interface ObjectMessageText {
  readonly key: 'message' | 'event'
  readonly text: string
}

/**
 * The entry text of an object message: its `message` string, else its `event` string. A member
 * that cannot be read (a throwing getter) is treated as absent.
 *
 * @param fields - The plain object the caller passed as the message.
 * @returns The text and its member, or `undefined` when neither member is a string.
 */
function objectMessageText(fields: Record<string, unknown>): ObjectMessageText | undefined {
  for (const key of ['message', 'event'] as const) {
    try {
      const value = Reflect.get(fields, key) as unknown
      if (typeof value === 'string') return { key, text: value }
    } catch {
      // A member that throws on read is not text; the next candidate, or no text, stands.
    }
  }
  return undefined
}

/**
 * Hide the message in the first line of the `stack` of an object message, where the options hide
 * `message`: the stack is a copy of it, and a copy made outside the pipeline would carry what the
 * pipeline hides in the field itself.
 *
 * @param payload - The fields of the entry, whose `stack` is replaced.
 * @param text - The text of the message and the member it came from.
 * @param censor - Censors a text as the `message` of an entry is.
 * @param positional - The stack the caller passed beside the message, which is not a field yet.
 * @returns The positional stack, with the message hidden in it.
 */
function hideStackMessage(
  payload: Record<string, unknown>,
  text: ObjectMessageText | undefined,
  censor: (message: string) => string,
  positional?: string
): string | undefined {
  const kept = positional === undefined ? undefined : cutText(positional)
  if (text?.key !== 'message') return kept
  const censored = censor(text.text)
  if (censored === text.text) return kept
  const keys = Object.keys(payload).filter(isStackKey)
  // Past the caps of the walk below the root, every stack is the censor.
  const overflow =
    keys.length + (positional === undefined ? 0 : 1) > MAX_STACK_ALIASES ||
    text.text.length > MAX_TEXT_LENGTH
  // The part searched reaches as far past the cut as the message is long, so a copy that starts before
  // the cut is hidden whole and none is left at the end; a stack of any length costs no more than the limit.
  const hide = (stack: string): string =>
    overflow
      ? censored
      : cutText(
          hideMessagesInStack(
            stack.slice(0, MAX_TEXT_LENGTH + text.text.length),
            [text.text],
            censored,
            MAX_TEXT_LENGTH
          ),
          stack.length > MAX_TEXT_LENGTH
        )
  for (const key of keys) {
    const stack = Reflect.get(payload, key) as unknown
    if (typeof stack === 'string') Reflect.set(payload, key, hide(stack))
  }
  return positional === undefined ? undefined : hide(positional)
}

/** A message read as the fields of an entry, with its text and the member the text came from. */
interface ObjectMessage {
  readonly fields: Record<string, unknown> | undefined
  readonly text: ObjectMessageText | undefined
  readonly payload: Record<string, unknown>
}

/**
 * Reads a plain-object `message` as the fields of the entry: the owned-key guard of `metadata`
 * applies, and the member the text came from is left out of the fields so it is written once.
 * Anything that is not a plain object has no fields and an empty payload.
 *
 * @param message - The value the caller passed as the message.
 * @returns The fields, the text, and the payload that carries them.
 */
function readObjectMessage(message: unknown): ObjectMessage {
  // An error-shaped object keeps its error-only path: its fields reach the entry as `err`, which
  // the error sanitizer has already cleaned, and not a second time at the root.
  const fields = isPlainRecord(message) && !isErrorLike(message) ? message : undefined
  const text = fields === undefined ? undefined : objectMessageText(fields)
  const omit = text?.key === 'message' ? 'message' : undefined
  const payload = withoutOwnedKeys(fields, omit)
  return { fields, text, payload }
}

/**
 * The log line for a caller-supplied `message`. A value with no text form (a null-prototype
 * object, a throwing `toString`) must not take the logging call down, so it becomes a fixed
 * stand-in.
 *
 * @param message - The value the caller passed as the message.
 * @returns A single-line message.
 */
function safeLogMessage(message: unknown): string {
  try {
    return toBoundedMessage(typeof message === 'string' ? message : String(message))
  } catch {
    return 'Unreadable log message'
  }
}

/**
 * The first `Error` among a NestJS variadic call's trailing parameters.
 *
 * NestJS types that slot as `stack?: string`, so this library read it as a string
 * and discarded anything else — but passing the `Error` itself is what callers
 * actually do, because every other logger in the ecosystem accepts it. The result
 * was that a caller supplied a cause and the entry carried none: no `err`, no
 * `stack`, no warning. Reported from a real run where an SMTP failure logged
 * "delivery failed" with the reason discarded, while the HTTP response was 204
 * and nothing had been delivered.
 *
 * Detected STRUCTURALLY rather than with `instanceof Error`, which is realm-local:
 * an error from a `vm` context or one already normalized into a plain
 * `{ name, message, stack }` — what `HttpExceptionFilter` produces, and what any
 * error crossing a process or worker boundary becomes — is not an `Error`
 * instance. Dropping those would leave the exact hole this function exists to
 * close. `isErrorLike` is the same detector `sanitizeError` uses, shared so the
 * two cannot disagree about what an error is.
 *
 * Scanned rather than read positionally, because the convention is not positional:
 * callers write `(message, error)` and `(message, error, context)` alike, and a
 * `context` string sits in the same tail.
 *
 * @param optionalParams - The variadic tail of a NestJS logger call.
 * @returns The first `Error` found, or `undefined` when the tail holds none.
 */
function findErrorParam(optionalParams: unknown[]): Error | undefined {
  return optionalParams.find((param): param is Error => isErrorLike(param))
}

/**
 * Write a reserved field onto a log payload ONLY when it has a value.
 *
 * This is load-bearing, not tidiness. Pino's default `mixinMergeStrategy` is
 * `Object.assign(mixinResult, mergeObject)`, so an OWN property whose value is
 * `undefined` still overwrites what the trace-context mixin read from the
 * AsyncLocalStorage store — and the key then vanishes during serialization.
 * Writing `userId: undefined` on every call where the argument was omitted is
 * what silently dropped the ambient `userId` from every structured entry, so a
 * `logContext.set('userId', …)` never reached a log unless each call site
 * repeated it. `requestId` / `tenantId` only ever survived because this class
 * does not name them.
 *
 * Precedence is therefore: explicit argument > ALS store > field absent.
 *
 * `Reflect.defineProperty` rather than assignment keeps the dynamic write off
 * the `security/detect-object-injection` sink list.
 *
 * @param payload - The log payload under construction.
 * @param key - Reserved field name.
 * @param value - Candidate value; the field is skipped when `undefined`.
 */
function assignIfDefined(payload: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    // Only `enumerable` is specified — see the equivalent note in
    // `redact-by-name.util.ts`. The payload goes straight to Pino, each reserved
    // key is written at most once, and nothing downstream re-assigns or deletes
    // it, so the remaining descriptor defaults are unobservable.
    Reflect.defineProperty(payload, key, bareDescriptor({ value, enumerable: true }))
  }
}

/**
 * Hand a record to Pino, unless a built-in method Pino calls for each log call is no longer the one
 * the module loaded with: a record is then dropped, since a lost log is better than a secret in one.
 *
 * @param pino - The Pino instance.
 * @param level - The Pino method.
 * @param payload - The fields of the entry.
 * @param msg - The message.
 */
function emitRecord(
  pino: PinoLogger,
  level: PinoLevelMethod | 'error',
  payload: Record<string, unknown>,
  msg: string
): void {
  if (pinoBuiltinsIntact()) pino[level](payload, msg)
}

/**
 * Pino-backed implementation of the NestJS `LoggerService` contract plus the
 * structured `MODULE_ACTION_RESULT` API.
 *
 * For a per-class context label, inject a CHILD logger already bound to that
 * context via `@InjectLogger(MyService.name)` — do NOT call `setContext()` per
 * class: this is a singleton, so a per-class `setContext()` clobbers the label
 * for every other holder (see {@link PinoLoggerService.setContext}).
 *
 * @example
 *   constructor(
 *     @InjectLogger(UserService.name) private readonly logger: PinoLoggerService,
 *   ) {}
 *   // ...
 *   this.logger.info('USER_CREATED', 'New user registered', userId, { plan: 'pro' })
 */
@Injectable()
export class PinoLoggerService implements NestLoggerService, OnApplicationShutdown {
  private context?: string

  /**
   * **A hand-built instance is NOT this library's behaviour.** Constructing
   * `new PinoLoggerService(pino({...}, sink))` directly works in the sense of not
   * throwing, and the parameter default below exists for exactly that — but the
   * Pino instance you built has none of the wiring `buildPinoInstance` installs,
   * and the omissions are silent:
   *
   *   - **no `err` serializer**, so an `Error` is serialized by Pino's default.
   *     The `cause` chain disappears ENTIRELY — no marker, no warning, and a
   *     `cause` that reads as "the field was never set";
   *   - **no name-based redaction** of serializer output or child bindings;
   *   - **no trace-context mixin**, so `requestId` / `tenantId` / OTel ids are
   *     absent;
   *   - **no size bound**, so nothing is truncated.
   *
   * That matters most for tests, which is the use this doc used to invite without
   * qualification: a consumer wrote one to check whether a `cause` carried its
   * `code`, measured absence, and nearly filed it against this library. The
   * absence was their harness. For a faithful harness, boot the module (or use
   * `BymaxLoggerModule.forRoot` in a testing module) rather than hand-building.
   *
   * @param pino - The wrapped Pino instance.
   * @param redact - The DEFAULT-coverage redactor, applied to `child()` bindings.
   *   Defaults to the identity so a hand-built instance still works; the module
   *   always injects the configured one.
   */
  constructor(
    @Inject(LOGGER_PINO_INSTANCE_TOKEN) private readonly pino: PinoLogger,
    @Inject(LOGGER_REDACTOR_TOKEN)
    private readonly redact: Redactor = (value) => value
  ) {}

  // ─── NestJS LoggerService variadic interface ──────────────────────────────

  /**
   * NestJS `log` (info level). Last string parameter is treated as the context.
   *
   * @param message - The message to log.
   * @param optionalParams - NestJS trailing params (context as last string).
   */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emitNestStyle('info', message, optionalParams)
  }

  /**
   * NestJS `error`. When `message` is an `Error`, routes to the structured
   * error path (serializing `err`). Otherwise follows the NestJS variadic
   * contract `error(message, stack?, context?)`, reading the stack and context
   * positionally so a trailing stack is never mistaken for the context.
   *
   * @param message - The message or `Error` to log.
   * @param optionalParams - NestJS trailing params (`stack` at index 0, `context` at index 1).
   */
  error(message: unknown, ...optionalParams: unknown[]): void {
    if (isErrorLike(message)) {
      const payload: Record<string, unknown> = { err: message }
      assignIfDefined(payload, 'context', this.resolveContext(optionalParams))
      emitRecord(this.pino, 'error', payload, this.errorText(message))
      return
    }
    // NestJS variadic contract is `error(message, stack?, context?)`: the stack
    // sits at index 0 and the context at index 1. Resolve the context
    // positionally (not "last string wins") so a 2-arg `error(msg, stack)` call
    // keeps the instance context instead of mistaking the stack for it.
    const stack = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined
    const context = typeof optionalParams[1] === 'string' ? optionalParams[1] : this.context
    // A plain-object message is the entry's fields, as in `emitNestStyle`.
    const { fields, text, payload } = readObjectMessage(message)
    // Hidden before it is attached: the field is written once.
    const positional = hideStackMessage(
      payload,
      text,
      (message) => this.censorText({ key: 'message', text: message }),
      stack
    )
    assignIfDefined(payload, 'context', context)
    assignIfDefined(payload, 'stack', positional)
    // An `Error` in the tail is attached as `err`, the same field the
    // leading-`Error` branch above writes, so `logger.error(msg, err)` and
    // `logger.error(err)` produce the same queryable shape. `stack` stays the
    // string case: the `err` serializer derives the stack from the Error itself,
    // so writing both would emit the same trace under two names.
    assignIfDefined(payload, 'err', findErrorParam(optionalParams))
    emitRecord(
      this.pino,
      'error',
      payload,
      this.nestStyleMessage('error', undefined, fields, text, message)
    )
  }

  /**
   * NestJS `warn` (warn level).
   *
   * @param message - The message to log.
   * @param optionalParams - NestJS trailing params (context as last string).
   */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emitNestStyle('warn', message, optionalParams)
  }

  /**
   * NestJS `debug` (debug level).
   *
   * @param message - The message to log.
   * @param optionalParams - NestJS trailing params (context as last string).
   */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emitNestStyle('debug', message, optionalParams)
  }

  /**
   * NestJS `verbose` (mapped to Pino `trace`).
   *
   * @param message - The message to log.
   * @param optionalParams - NestJS trailing params (context as last string).
   */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emitNestStyle('trace', message, optionalParams)
  }

  /**
   * NestJS `fatal` (fatal level). Declared non-optional here: Pino supports
   * level 60 natively, and widening the optional `LoggerService.fatal?` to a
   * required method stays type-compatible.
   *
   * @param message - The message to log.
   * @param optionalParams - NestJS trailing params (context as last string).
   */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emitNestStyle('fatal', message, optionalParams)
  }

  // ─── Structured API (MODULE_ACTION_RESULT convention) ─────────────────────

  /**
   * Emit a structured info log.
   *
   * @param logKey - Convention key, e.g. `USER_CREATED`.
   * @param message - Human-readable message.
   * @param userId - Optional acting user identifier.
   * @param metadata - Optional extra structured fields.
   * @example
   *   logger.info('USER_CREATED', 'New user registered', userId, { plan: 'pro' })
   */
  info(logKey: string, message: string, userId?: string, metadata?: Record<string, unknown>): void {
    this.emitStructured('info', logKey, message, userId, metadata)
  }

  /**
   * Emit a structured warning log.
   *
   * @param logKey - Convention key.
   * @param message - Human-readable message.
   * @param userId - Optional acting user identifier.
   * @param metadata - Optional extra structured fields.
   */
  warnStructured(
    logKey: string,
    message: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.emitStructured('warn', logKey, message, userId, metadata)
  }

  /**
   * Emit a structured error log with a serialized `err` object.
   *
   * @param logKey - Convention key.
   * @param error - The error to serialize (`name` / `message` / `stack`).
   * @param userId - Optional acting user identifier.
   * @param metadata - Optional extra structured fields.
   */
  errorStructured(
    logKey: string,
    error: Error,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    // The owned keys are stripped from `metadata` (not overwritten after the
    // spread) because `userId` / `context` are now written only when defined —
    // see OWNED_PAYLOAD_KEYS. `err` is still written unconditionally below.
    const payload: Record<string, unknown> = {
      ...withoutOwnedKeys(metadata),
      logKey,
      // The RAW value, not a pre-serialized copy. Pre-serializing was what let
      // Pino's standard `err` serializer re-derive `type` from the resulting
      // plain object's constructor and emit `"Object"` for every typed
      // exception — and it discarded the cause chain on the way. The configured
      // serializer owns the shape now.
      err: error
    }
    assignIfDefined(payload, 'userId', userId)
    assignIfDefined(payload, 'context', this.context)
    emitRecord(this.pino, 'error', payload, this.errorText(error))
  }

  // ─── Helpers / escape hatches ─────────────────────────────────────────────

  /**
   * Set the global context label applied to subsequent logs from THIS instance.
   *
   * WARNING: `PinoLoggerService` is a singleton. Calling this per class clobbers
   * the label for every other holder, and calling it at request time is a
   * cross-request race. For a per-class label use `@InjectLogger(MyClass.name)`
   * (which binds a child logger instead of mutating shared state); reserve
   * `setContext()` for a single global / bootstrap label.
   *
   * @param context - The context label.
   */
  setContext(context: string): void {
    this.context = context
  }

  /**
   * Access the underlying Pino instance for advanced use cases.
   *
   * @returns The wrapped Pino logger.
   */
  getRawLogger(): PinoLogger {
    return this.pino
  }

  /**
   * Create a child logger with additional permanent bindings, inheriting the
   * current context label.
   *
   * @param bindings - Fields merged into every entry of the child logger.
   * @returns A new `PinoLoggerService` wrapping the Pino child.
   */
  child(bindings: Record<string, unknown>): PinoLoggerService {
    // Bindings are redacted HERE, not by the factory's `formatters.log` hook:
    // Pino pre-serializes child bindings into the instance's `chindings`
    // fragment at `child()` time, so that hook never sees them. Under the `'names'`
    // strategy the factory's instance redacts them in its own `child()` too; this
    // also covers an instance the service was handed that the factory did not build.
    // `true`: bindings are a record root — Pino iterates them into `chindings`
    // rather than serializing them, so a `toJSON` on the bag must not replace it.
    const safeBindings = this.redact(bindings, true) as Record<string, unknown>
    const childService = new PinoLoggerService(this.pino.child(safeBindings), this.redact)
    if (this.context !== undefined) {
      childService.setContext(this.context)
    }
    return childService
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * NestJS shutdown hook. Destination flushing is handled by `DestinationRegistry`;
   * this service has no additional teardown work.
   */
  onApplicationShutdown(): void {
    // Intentionally empty; DestinationRegistry manages its own flush on shutdown.
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Resolve the context: last string param wins, else the instance context. */
  private resolveContext(optionalParams: unknown[]): string | undefined {
    const last = optionalParams[optionalParams.length - 1]
    return typeof last === 'string' ? last : this.context
  }

  /** Emit a structured payload at info or warn level. */
  private emitStructured(
    level: 'info' | 'warn',
    logKey: string,
    message: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    // The owned keys are stripped from `metadata` (not overwritten after the
    // spread) because `userId` / `context` are now written only when defined —
    // see OWNED_PAYLOAD_KEYS.
    const payload: Record<string, unknown> = { ...withoutOwnedKeys(metadata), logKey }
    assignIfDefined(payload, 'userId', userId)
    assignIfDefined(payload, 'context', this.context)
    const line = toBoundedMessage(message)
    if (level === 'info') {
      emitRecord(this.pino, 'info', payload, line)
    } else {
      emitRecord(this.pino, 'warn', payload, line)
    }
  }

  /** Emit a NestJS-style variadic log, dispatching by level without computed indexing. */
  private nestStyleMessage(
    level: PinoLevelMethod | 'error',
    leading: Error | undefined,
    fields: Record<string, unknown> | undefined,
    text: ObjectMessageText | undefined,
    message: unknown
  ): string {
    if (leading !== undefined) return this.errorText(leading)
    if (fields !== undefined) {
      return toBoundedMessage(this.censorText(text, { emitted: this.pino.isLevelEnabled(level) }))
    }
    return safeLogMessage(message)
  }

  /**
   * Censor a text as the `message` of an entry is: under the name `message`, by the rules of
   * `redactPaths` and `redactCensor`, and neither cut nor counted. The lines the library writes to
   * `stderr` about a failure use it for the message of the error they carry.
   *
   * @internal Used by `PinoUnexpectedErrorSink`. NOT part of the supported API.
   * @param text - The text to censor.
   * @returns The text, or what hides it, and an empty text when the censor itself fails.
   */
  censorMessageText(text: string): string {
    return this.censorText({ key: 'message', text })
  }

  /**
   * The entry text of an `Error`: its `message`, read without letting a hostile getter escape, then
   * censored under the name `message`, as the field `err.message` it is a copy of. It is not cut at
   * `maxStringLength`; `toBoundedMessage` caps it.
   *
   * @param error - The error being logged.
   * @returns The text of the entry.
   */
  private errorText(error: Error): string {
    return toBoundedMessage(this.censorText({ key: 'message', text: safeErrorMessage(error) }))
  }

  /**
   * The entry text of an object message, censored under the names of the field it came from and cut
   * like that field: the text is a copy of it, and a copy made outside the pipeline would carry a
   * value the pipeline censors or cuts in the field itself.
   *
   * @param text - The text and the member it came from.
   * @param cut - Present when the text is cut at `maxStringLength`; says whether the entry is
   *   written, so that a cut of it is counted.
   * @returns The censored text, or an empty one when the redactor cannot be applied.
   */
  private censorText(text: ObjectMessageText | undefined, cut?: EntryTextCut): string {
    if (text === undefined) return ''
    const finish =
      (Reflect.get(this.pino, ENTRY_TEXT_FINISHER) as EntryTextFinisher | undefined) ??
      createEntryTextFinisher(this.redact, undefined)
    return finish(text.key, text.text, cut)
  }

  private emitNestStyle(level: PinoLevelMethod, message: unknown, optionalParams: unknown[]): void {
    // A plain object is the entry's fields, not text: `String(message)` would reduce it to
    // "[object Object]" and lose every key. The fields go through the same owned-key guard as
    // `metadata`, and then through the redaction and string-limit pipeline like any other payload.
    const { fields, text, payload } = readObjectMessage(message)
    hideStackMessage(payload, text, (message) => this.censorText({ key: 'message', text: message }))
    assignIfDefined(payload, 'context', this.resolveContext(optionalParams))
    // Every level except `error` routes through here, so before this all of them
    // lost an `Error` in BOTH positions — measured at eleven of the twelve
    // level/position combinations, with `error(err)` the only surviving path. A
    // cause handed to `warn` or `fatal` is exactly as much a cause as one handed
    // to `error`, and `fatal` is the worst place to drop it: it is the level a
    // caller reaches for when the process is about to die.
    const leading = isErrorLike(message) ? message : undefined
    assignIfDefined(payload, 'err', leading ?? findErrorParam(optionalParams))
    // A leading `Error` becomes the message, matching what `error(err)` emits —
    // `String(error)` would have produced the `"Error: …"` prefix instead.
    const msg = this.nestStyleMessage(level, leading, fields, text, message)
    emitRecord(this.pino, level, payload, msg)
  }
}
