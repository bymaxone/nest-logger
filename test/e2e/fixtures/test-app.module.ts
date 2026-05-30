/**
 * E2E fixture application module.
 *
 * Wires the logger with HTTP logging enabled and registers the request-id
 * middleware via the public `applyRequestIdMiddleware` helper — mirroring the
 * canonical consumer setup documented in the README.
 */
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { applyRequestIdMiddleware, BymaxLoggerModule } from '@bymax-one/nest-logger'

import { TestController } from './test.controller'

/** Fixture app: logger (http enabled) + the test controller + request-id middleware. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e', version: '0.0.0' },
      http: { isEnabled: true }
    })
  ],
  controllers: [TestController]
})
export class TestAppModule implements NestModule {
  /**
   * Register the request-id middleware on every route via the public helper.
   *
   * @param consumer - The middleware consumer from NestJS.
   */
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}
