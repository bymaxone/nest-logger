/**
 * `applyRequestIdMiddleware` consumer helper.
 *
 * Layer: server/middlewares — NestJS requires middleware to be wired in a
 * module's `configure(consumer)` hook, which the library cannot do on the
 * consumer's behalf. This helper encapsulates the wiring so consumers do not
 * import the middleware classes directly.
 *
 * It registers TWO middlewares, in order: the correlation scope, then the access
 * log that runs inside it. Both run before any guard, which is the whole point —
 * an interceptor never observes a request a guard rejected.
 */
import type { MiddlewareConsumer } from '@nestjs/common'

import { HttpAccessLogMiddleware } from './http-access-log.middleware'
import { RequestIdMiddleware } from './request-id.middleware'

/**
 * Default route the middleware is applied to: a MOUNT at the root, not a
 * wildcard pattern.
 *
 * Under NestJS 11 (Express 5 / path-to-regexp v8) a wildcard is a named
 * parameter with segment-count semantics, and every pattern spelling loses a
 * route. Measured in this repo, requesting `/` and `/items/9` with and without
 * `setGlobalPrefix('api')`:
 *
 * | pattern      | no prefix | with `setGlobalPrefix('api')` |
 * | ------------ | --------- | ----------------------------- |
 * | `'*'`        | all       | MISSES `/api`                 |
 * | `'{*splat}'` | all       | MISSES `/api`                 |
 * | `'/'`        | all       | all                           |
 *
 * `'*'` was the previous default, so the correlation scope — and now the access
 * log — silently skipped the prefixed root route of every app using a global
 * prefix. The failure mode is ABSENCE: no error, just a request that never
 * appears. `'/'` mounts rather than matches, so it covers everything below the
 * mount point whatever the prefix.
 */
const ALL_ROUTES = '/'

/**
 * Register {@link RequestIdMiddleware} on the given consumer.
 *
 * @param consumer - The `MiddlewareConsumer` from the module's `configure` hook.
 * @param routes - Route pattern(s) to apply the middleware to. Defaults to all.
 * @example
 *   import { applyRequestIdMiddleware } from '@bymax-one/nest-logger'
 *
 *   @Module({ imports: [BymaxLoggerModule.forRoot({ service, http: { isEnabled: true } })] })
 *   export class AppModule implements NestModule {
 *     configure(consumer: MiddlewareConsumer): void {
 *       applyRequestIdMiddleware(consumer)
 *     }
 *   }
 */
export function applyRequestIdMiddleware(
  consumer: MiddlewareConsumer,
  routes: string = ALL_ROUTES
): void {
  // Order is load-bearing and guaranteed within a single `apply()` call:
  // `RequestIdMiddleware` opens the AsyncLocalStorage scope, and
  // `HttpAccessLogMiddleware` must run INSIDE it or its entries carry no
  // `requestId` / trace context. Both still run before any guard.
  consumer.apply(RequestIdMiddleware, HttpAccessLogMiddleware).forRoutes(routes)
}
