/**
 * `applyRequestIdMiddleware` consumer helper.
 *
 * Layer: server/middlewares — NestJS requires middleware to be wired in a
 * module's `configure(consumer)` hook, which the library cannot do on the
 * consumer's behalf. This helper encapsulates the one-liner so consumers do not
 * import the middleware class directly.
 *
 * See `docs/development_plan.md` §4.5 for the design rationale.
 */
import type { MiddlewareConsumer } from '@nestjs/common'

import { RequestIdMiddleware } from './request-id.middleware'

/** Default route pattern the middleware is applied to (all routes). */
const ALL_ROUTES = '*'

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
  consumer.apply(RequestIdMiddleware).forRoutes(routes)
}
