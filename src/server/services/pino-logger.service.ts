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

import { LOGGER_PINO_INSTANCE_TOKEN } from '../constants/injection-tokens.constants'

/** Pino level methods the NestJS-style variadic path dispatches to (error is handled separately). */
type PinoLevelMethod = 'info' | 'warn' | 'debug' | 'trace' | 'fatal'

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

  constructor(@Inject(LOGGER_PINO_INSTANCE_TOKEN) private readonly pino: PinoLogger) {}

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
      this.pino.error(
        { context: this.resolveContext(optionalParams), err: this.serializeError(message) },
        message.message
      )
      return
    }
    // NestJS variadic contract is `error(message, stack?, context?)`: the stack
    // sits at index 0 and the context at index 1. Resolve the context
    // positionally (not "last string wins") so a 2-arg `error(msg, stack)` call
    // keeps the instance context instead of mistaking the stack for it.
    const stack = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined
    const context = typeof optionalParams[1] === 'string' ? optionalParams[1] : this.context
    const payload: Record<string, unknown> = { context }
    if (stack !== undefined) {
      payload['stack'] = stack
    }
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
    // Reserved fields are written AFTER metadata so a caller-supplied `metadata`
    // key cannot clobber logKey / userId / context / err.
    this.pino.error(
      { ...metadata, logKey, userId, context: this.context, err: this.serializeError(error) },
      error.message
    )
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
    const childService = new PinoLoggerService(this.pino.child(bindings))
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

  /**
   * Serialize an Error into a plain, log-safe object matching Pino's built-in
   * `err` serializer shape (`type`, `message`, `stack`).
   *
   * Reads `error.name` (NOT `error.constructor.name`) for `type`: native
   * subclasses set `name` to their class name, and a sanitized plain-object error
   * (from `sanitizeError`) carries the real class name on `name` — whereas its
   * `constructor.name` would be the unhelpful `'Object'`, breaking `err.type`
   * dashboards for every exception logged through `HttpExceptionFilter`.
   */
  private serializeError(error: Error): Record<string, unknown> {
    return { type: error.name, message: error.message, stack: error.stack }
  }

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
    // Reserved fields are spread AFTER metadata so a caller-supplied key in
    // `metadata` (e.g. `logKey`) can never clobber the structured contract.
    const payload: Record<string, unknown> = {
      ...metadata,
      logKey,
      userId,
      context: this.context
    }
    if (level === 'info') {
      this.pino.info(payload, message)
    } else {
      this.pino.warn(payload, message)
    }
  }

  /** Emit a NestJS-style variadic log, dispatching by level without computed indexing. */
  private emitNestStyle(level: PinoLevelMethod, message: unknown, optionalParams: unknown[]): void {
    const payload: Record<string, unknown> = { context: this.resolveContext(optionalParams) }
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
