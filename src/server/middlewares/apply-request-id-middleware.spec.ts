import type { MiddlewareConsumer } from '@nestjs/common'

import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import { HttpAccessLogMiddleware } from './http-access-log.middleware'
import { RequestIdMiddleware } from './request-id.middleware'

/** Consumer double recording what was applied and where. */
function createConsumer(): {
  consumer: MiddlewareConsumer
  applied: unknown[]
  routes: unknown[]
} {
  const applied: unknown[] = []
  const routes: unknown[] = []
  const consumer = {
    apply: (...middlewares: unknown[]): { forRoutes: (...r: unknown[]) => void } => {
      applied.push(...middlewares)
      return {
        forRoutes: (...r: unknown[]): void => {
          routes.push(...r)
        }
      }
    }
  } as unknown as MiddlewareConsumer
  return { consumer, applied, routes }
}

describe('applyRequestIdMiddleware', () => {
  it(/*
   * Order is load-bearing: `RequestIdMiddleware` opens the AsyncLocalStorage
   * scope and `HttpAccessLogMiddleware` must run INSIDE it, or every access-log
   * entry ships without a `requestId`. A single `apply()` call is what guarantees
   * the order, so both classes and their sequence are asserted here rather than
   * inferred from a serialized line.
   */
  'applies the correlation scope before the access log', () => {
    const { consumer, applied } = createConsumer()

    applyRequestIdMiddleware(consumer)

    expect(applied).toEqual([RequestIdMiddleware, HttpAccessLogMiddleware])
  })

  it(/*
   * The default is a MOUNT at the root, not a wildcard. Measured in this repo:
   * under NestJS 11 (Express 5 / path-to-regexp v8) both `'*'` and `'{*splat}'`
   * stop matching the prefixed root once the app calls `setGlobalPrefix`, so the
   * previous `'*'` default silently skipped `GET /api` — no error, just a request
   * that never appears in the log.
   */
  'defaults to mounting at the root', () => {
    const { consumer, routes } = createConsumer()

    applyRequestIdMiddleware(consumer)

    expect(routes).toEqual(['/'])
  })

  it(/*
   * A consumer scoping the middleware to a subtree must still be honoured — the
   * default is a default, not a hard-coded route.
   */
  'passes an explicit route through', () => {
    const { consumer, routes } = createConsumer()

    applyRequestIdMiddleware(consumer, '/api/v1')

    expect(routes).toEqual(['/api/v1'])
  })
})
