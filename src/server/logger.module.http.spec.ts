/**
 * Asserts which providers BymaxLoggerModule.forRoot registers (neither interceptor nor filter with http
 * disabled, both when enabled, the interceptor alone with exception capture off) and that forRootAsync
 * registers no exception filter provider.
 * Layer: server, tests.
 */
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import type { DynamicModule, Provider } from '@nestjs/common'

import { BymaxLoggerModule } from './logger.module'

/** True when the provider list contains a non-class provider for `token`. */
function hasProvider(providers: Provider[] | undefined, token: unknown): boolean {
  return (providers ?? []).some(
    (provider) =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token
  )
}

/** Resolve the providers of a forRoot dynamic module for the given http options. */
function providersFor(http?: Record<string, unknown>): Provider[] | undefined {
  const dynamicModule: DynamicModule = BymaxLoggerModule.forRoot({
    service: { name: 'http-wiring-test', version: '1.0.0' },
    ...(http ? { http } : {})
  })
  return dynamicModule.providers
}

describe('BymaxLoggerModule HTTP wiring (forRoot)', () => {
  it(/*
   * HTTP logging must be strictly opt-in: with no http config neither the global
   * interceptor nor the filter may be registered, so the lib stays inert by
   * default.
   */
  'registers neither interceptor nor filter when http is disabled', () => {
    const providers = providersFor()

    expect(hasProvider(providers, APP_INTERCEPTOR)).toBe(false)
    expect(hasProvider(providers, APP_FILTER)).toBe(false)
  })

  it(/*
   * Enabling http (with the default shouldCaptureExceptions) must register both
   * the global interceptor and the exception filter.
   */
  'registers both interceptor and filter when http is enabled', () => {
    const providers = providersFor({ isEnabled: true })

    expect(hasProvider(providers, APP_INTERCEPTOR)).toBe(true)
    expect(hasProvider(providers, APP_FILTER)).toBe(true)
  })

  it(/*
   * shouldCaptureExceptions:false must register the access-log interceptor but
   * NOT the catch-all filter — covers the inner conditional and lets consumers
   * keep their own exception handling.
   */
  'registers the interceptor but not the filter when exception capture is off', () => {
    const providers = providersFor({ isEnabled: true, shouldCaptureExceptions: false })

    expect(hasProvider(providers, APP_INTERCEPTOR)).toBe(true)
    expect(hasProvider(providers, APP_FILTER)).toBe(false)
  })
})

describe('BymaxLoggerModule HTTP wiring (forRootAsync)', () => {
  it(/*
   * The catch-all filter is never wired from asynchronously resolved options: a global filter
   * added from them would sit in every consumer's pipeline whether or not HTTP logging is on.
   * An asynchronous consumer registers `HttpExceptionFilter` itself, which the end-to-end cases
   * in `test/e2e/exception-filter-wiring.e2e-spec.ts` pin.
   */
  'registers no exception filter, even with http enabled', () => {
    const dynamicModule = BymaxLoggerModule.forRootAsync({
      useFactory: () => ({
        service: { name: 'http-wiring-test', version: '1.0.0' },
        http: { isEnabled: true }
      })
    })

    expect(hasProvider(dynamicModule.providers, APP_FILTER)).toBe(false)
  })
})
