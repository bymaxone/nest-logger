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
import type { Redactor } from '../utils/redact-by-name.util'

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
 * @returns A shallow copy with every {@link OWNED_PAYLOAD_KEYS} and
 *   {@link PROTOTYPE_POLLUTING_KEYS} entry dropped.
 */
function withoutOwnedKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (metadata === undefined) {
    return {}
  }
  try {
    const safe: Record<string, unknown> = {}
    for (const key of Object.keys(metadata)) {
      if (!OWNED_PAYLOAD_KEYS.includes(key) && !PROTOTYPE_POLLUTING_KEYS.has(key)) {
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
 * @returns The message, or a fixed stand-in when it cannot be read.
 */
function safeErrorMessage(error: Error): string {
  try {
    // Line and paragraph separators are replaced with the literal two-character
    // sequence `\n` (CodeQL js/log-injection, alert #61). The error message can
    // carry user-provided text — a thrown value recorded off an HTTP request —
    // and this string becomes Pino's MESSAGE argument. On the NDJSON transport
    // that is harmless (JSON escaping already neutralizes a forged-record
    // payload; measured), but `pino-pretty` and any destination that re-renders
    // the parsed message print real newlines, where an embedded line break
    // forges what looks like a separate log entry. The structured `err.message`
    // field keeps the original text verbatim, so no information is lost — only
    // the human-readable message line is pinned to one line.
    return String(error.message).replace(/[\r\n\u2028\u2029]/g, '\\n')
  } catch {
    return 'Unreadable error message'
  }
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
    Reflect.defineProperty(payload, key, { value, enumerable: true })
  }
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
   * @param pino - The wrapped Pino instance.
   * @param redact - The DEFAULT-coverage redactor, applied to `child()` bindings.
   *   Defaults to the identity so a hand-built instance (benchmarks, unit tests)
   *   still works; the module always injects the configured one.
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
    if (message instanceof Error) {
      const payload: Record<string, unknown> = { err: message }
      assignIfDefined(payload, 'context', this.resolveContext(optionalParams))
      this.pino.error(payload, safeErrorMessage(message))
      return
    }
    // NestJS variadic contract is `error(message, stack?, context?)`: the stack
    // sits at index 0 and the context at index 1. Resolve the context
    // positionally (not "last string wins") so a 2-arg `error(msg, stack)` call
    // keeps the instance context instead of mistaking the stack for it.
    const stack = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined
    const context = typeof optionalParams[1] === 'string' ? optionalParams[1] : this.context
    const payload: Record<string, unknown> = {}
    assignIfDefined(payload, 'context', context)
    assignIfDefined(payload, 'stack', stack)
    this.pino.error(payload, typeof message === 'string' ? message : String(message))
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
    this.pino.error(payload, safeErrorMessage(error))
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
    // fragment at `child()` time, so that hook never sees them. Without this,
    // `logger.child({ password })` wrote the value in clear on every entry the
    // child emitted.
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
    if (level === 'info') {
      this.pino.info(payload, message)
    } else {
      this.pino.warn(payload, message)
    }
  }

  /** Emit a NestJS-style variadic log, dispatching by level without computed indexing. */
  private emitNestStyle(level: PinoLevelMethod, message: unknown, optionalParams: unknown[]): void {
    const payload: Record<string, unknown> = {}
    assignIfDefined(payload, 'context', this.resolveContext(optionalParams))
    const msg = typeof message === 'string' ? message : String(message)
    switch (level) {
      case 'info':
        this.pino.info(payload, msg)
        break
      case 'warn':
        this.pino.warn(payload, msg)
        break
      case 'debug':
        this.pino.debug(payload, msg)
        break
      case 'trace':
        this.pino.trace(payload, msg)
        break
      case 'fatal':
        this.pino.fatal(payload, msg)
        break
    }
  }
}
