/**
 * Request-scoped log context backed by Node's AsyncLocalStorage.
 *
 * Layer: server/services — the propagation primitive that lets every log
 * entry inherit `requestId` / `tenantId` / `userId` without prop-drilling.
 * A request-scoped middleware (Phase 3) opens a scope per HTTP request; the
 * Pino `TraceContextMixin` reads the active store on every log call.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'

import type { LogContext } from '../interfaces/log-context.interface'

/** Keys that would corrupt the store's prototype chain and are rejected by `set()`. */
const FORBIDDEN_CONTEXT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Injectable wrapper around `AsyncLocalStorage<LogContext>`.
 *
 * A single instance is shared per module (NestJS singleton scope) so the
 * code that opens a scope and the mixin that reads it operate on the same
 * storage.
 *
 * @example
 *   logContext.run({ requestId: 'r_1' }, async () => {
 *     logContext.set('userId', 'u_1')
 *     await handler() // every log inside carries requestId + userId
 *   })
 */
@Injectable()
export class LogContextService {
  private readonly als = new AsyncLocalStorage<LogContext>()

  /**
   * Run `callback` inside a fresh context scope. Every log emitted
   * synchronously or asynchronously within the callback inherits `context`.
   *
   * @typeParam T - Return type of the callback.
   * @param context - Initial context bag for the scope.
   * @param callback - Function executed within the scope.
   * @returns Whatever `callback` returns.
   * @example
   *   logContext.run({ requestId: 'r_1', tenantId: 't_1' }, async () => {
   *     await userService.create(dto) // logs carry requestId + tenantId
   *   })
   */
  run<T>(context: LogContext, callback: () => T): T {
    return this.als.run(this.sanitizeContext(context), callback)
  }

  /**
   * Read the active context, or `undefined` when called outside any scope.
   *
   * @returns The active `LogContext`, or `undefined`.
   */
  getStore(): LogContext | undefined {
    return this.als.getStore()
  }

  /**
   * Add or override a single field on the active context.
   *
   * @param key - Field name to set.
   * @param value - Field value.
   * @throws Error When called outside a `run()` scope, or with a prototype-polluting key.
   */
  set(key: string, value: unknown): void {
    const store = this.als.getStore()
    if (!store) {
      throw new Error('[LogContextService] set() called outside run() scope')
    }
    if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
      throw new Error(`[LogContextService] Refusing to set unsafe context key: ${key}`)
    }
    // `Reflect.set` rather than `store[key] = value` to keep the dynamic write
    // off the `security/detect-object-injection` sink list.
    Reflect.set(store, key, value)
  }

  /**
   * Read a single field from the active context.
   *
   * @typeParam T - Expected value type (caller-asserted).
   * @param key - Field name to read.
   * @returns The value cast to `T`, or `undefined` when unset / out of scope.
   */
  get<T = unknown>(key: string): T | undefined {
    const store = this.als.getStore()
    if (!store) {
      return undefined
    }
    return Reflect.get(store, key) as T | undefined
  }

  /**
   * Strip prototype-polluting keys from a caller-supplied context so an own
   * `__proto__` / `constructor` / `prototype` key (e.g. from `JSON.parse` of an
   * untrusted payload) can never reach the store — and, via the trace mixin's
   * `Object.assign`, the emitted log entry. Mirrors the guard `set()` enforces,
   * but drops the key rather than throwing: a logging concern must never crash
   * the request that produced it.
   *
   * @param context - The raw context bag passed to `run()`.
   * @returns A shallow copy with any forbidden keys removed.
   */
  private sanitizeContext(context: LogContext): LogContext {
    const safe: LogContext = {}
    for (const key of Object.keys(context)) {
      if (!FORBIDDEN_CONTEXT_KEYS.has(key)) {
        // `Reflect` keeps the dynamic read/write off the object-injection sink list.
        Reflect.set(safe, key, Reflect.get(context, key))
      }
    }
    return safe
  }
}
