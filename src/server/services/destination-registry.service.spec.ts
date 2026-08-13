jest.mock('../utils/otel-detector', () => ({
  ...jest.requireActual<typeof import('../utils/otel-detector')>('../utils/otel-detector'),
  detectOtelTraceApi: jest.fn()
}))

import pino from 'pino'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { applyDefaults } from '../config/default-options'
import { detectOtelTraceApi } from '../utils/otel-detector'

import { DestinationRegistry } from './destination-registry.service'
import { PinoLoggerService } from './pino-logger.service'

/** Build a mock destination with optional lifecycle hooks. */
function makeDestination(
  name: string,
  hooks: {
    onInit?: () => Promise<void> | void
    onShutdown?: () => Promise<void> | void
  } = {}
): ILogDestination {
  return { name, write: jest.fn(), ...hooks }
}

describe('DestinationRegistry', () => {
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  let logger: PinoLoggerService
  let errorSpy: jest.SpyInstance
  let infoSpy: jest.SpyInstance

  beforeEach(() => {
    // A real but silent Pino instance avoids fabricating a Logger mock (cast-free).
    logger = new PinoLoggerService(pino({ enabled: false }))
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation(() => undefined)
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined)
  })

  describe('onModuleInit', () => {
    it(/*
     * Every registered destination must be initialized and marked active —
     * including one with no onInit hook (the optional-chain must not break it).
     */
    'initializes every destination and marks them active', async () => {
      const withHook = makeDestination('with-hook', { onInit: jest.fn() })
      const hookless = makeDestination('hookless')
      const registry = new DestinationRegistry([withHook, hookless], logger, options)

      await registry.onModuleInit()

      expect(withHook.onInit).toHaveBeenCalledTimes(1)
      expect(registry.getActive()).toEqual([withHook, hookless])
    })

    it(/*
     * A destination whose onInit throws must be dropped from the active set and
     * reported via LOGGER_DESTINATION_INIT_FAILED — without aborting boot or
     * preventing the healthy destinations from initializing.
     */
    'skips a failing destination and reports it without blocking the others', async () => {
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const healthy = makeDestination('healthy', { onInit: jest.fn() })
      const registry = new DestinationRegistry([boom, healthy], logger, options)

      await registry.onModuleInit()

      expect(registry.getActive()).toEqual([healthy])
      expect(errorSpy).toHaveBeenCalledWith(
        RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
        expect.any(Error),
        undefined,
        { destination: 'boom' }
      )
    })

    it(/*
     * A non-Error thrown from onInit (e.g. a bare string) must be coerced into an
     * Error so errorStructured always receives a serializable Error.
     */
    'coerces a non-Error onInit failure into an Error', async () => {
      const weird = makeDestination('weird', {
        onInit: jest.fn().mockRejectedValue('string-failure')
      })
      const registry = new DestinationRegistry([weird], logger, options)

      await registry.onModuleInit()

      const reportedError = errorSpy.mock.calls[0]?.[1]
      expect(reportedError).toBeInstanceOf(Error)
      expect(reportedError).toHaveProperty('message', 'string-failure')
    })
  })

  describe('onApplicationShutdown', () => {
    it(/*
     * REGRESSION — audit finding D-1. `LOGGER_SHUTDOWN_OK` was declared in the
     * reserved catalog and never written. It is the bookend to
     * `LOGGER_BOOTSTRAP_OK`: its absence in a log stream is how an operator
     * tells a graceful shutdown from a killed process. Message and metadata are
     * asserted, and the emission must happen BEFORE any sink is torn down —
     * an entry written after the destinations closed would have nowhere to go.
     */
    'emits LOGGER_SHUTDOWN_OK before tearing any destination down', async () => {
      const seenAtShutdown: number[] = []
      const destination = makeDestination('sink', {
        onInit: jest.fn(),
        onShutdown: jest.fn(() => {
          seenAtShutdown.push(infoSpy.mock.calls.length)
        })
      })
      const registry = new DestinationRegistry([destination], logger, options)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(infoSpy).toHaveBeenCalledWith(
        RESERVED_LOG_KEYS.LOGGER_SHUTDOWN_OK,
        'BymaxLoggerModule shutting down',
        undefined,
        { destinations: 1 }
      )
      // Two info calls by then: the bootstrap announcement from onModuleInit and
      // the shutdown entry — the sink observed the latter already emitted when
      // its own teardown ran.
      expect(seenAtShutdown).toEqual([2])
    })

    it(/*
     * Destinations must shut down in REVERSE registration order so the
     * first-registered sink (typically stdout) closes last.
     */
    'shuts down active destinations in reverse order', async () => {
      const order: string[] = []
      const first = makeDestination('first', {
        onInit: jest.fn(),
        onShutdown: jest.fn(() => {
          order.push('first')
        })
      })
      const second = makeDestination('second', {
        onInit: jest.fn(),
        onShutdown: jest.fn(() => {
          order.push('second')
        })
      })
      const registry = new DestinationRegistry([first, second], logger, options)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(order).toEqual(['second', 'first'])
    })

    it(/*
     * A destination without an onShutdown hook must not break graceful shutdown.
     */
    'tolerates a destination without an onShutdown hook', async () => {
      const hookless = makeDestination('hookless', { onInit: jest.fn() })
      const registry = new DestinationRegistry([hookless], logger, options)
      await registry.onModuleInit()

      await expect(registry.onApplicationShutdown()).resolves.toBeUndefined()
    })

    it(/*
     * If a destination's onShutdown throws an Error, the failure must fall back
     * to process.stderr.write using the error's stack (or message when no stack).
     */
    'falls back to process.stderr.write when onShutdown throws an Error', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const boom = makeDestination('boom', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(new Error('shutdown-fail'))
      })
      const registry = new DestinationRegistry([boom], logger, options)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Shutdown failed for "boom"'))
      stderrSpy.mockRestore()
    })

    it(/*
     * When the thrown cause is a non-Error value (e.g. a string), String(cause)
     * must be used as the detail — covers the instanceof-false branch.
     */
    'falls back to process.stderr.write when onShutdown throws a non-Error', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const boom = makeDestination('boom', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue('non-error-string')
      })
      const registry = new DestinationRegistry([boom], logger, options)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('non-error-string'))
      stderrSpy.mockRestore()
    })

    it(/*
     * When the Error has no stack (e.g. stripped by a transpiler), the message
     * must be used as the detail — covers the stack ?? message branch.
     */
    'uses error.message when stack is absent', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stacklessError = new Error('no-stack')
      Reflect.deleteProperty(stacklessError, 'stack')
      const boom = makeDestination('boom', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(stacklessError)
      })
      const registry = new DestinationRegistry([boom], logger, options)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('no-stack'))
      stderrSpy.mockRestore()
    })
  })

  describe('getActive', () => {
    it(/*
     * Before onModuleInit runs, the active set must be empty (not the registered
     * list) — nothing is "active" until it has successfully initialized.
     */
    'returns an empty list before initialization', () => {
      const registry = new DestinationRegistry([makeDestination('a')], logger, options)
      expect(registry.getActive()).toEqual([])
    })
  })
})

describe('DestinationRegistry — OTel availability warning', () => {
  const mockedDetect = jest.mocked(detectOtelTraceApi)
  let logger: PinoLoggerService
  let warnSpy: jest.SpyInstance

  /** Boot a registry with the given options and capture its structured warnings. */
  async function boot(overrides: Parameters<typeof applyDefaults>[0]): Promise<void> {
    logger = new PinoLoggerService(pino({ enabled: false }))
    warnSpy = jest.spyOn(logger, 'warnStructured').mockImplementation()
    const registry = new DestinationRegistry([], logger, applyDefaults(overrides))
    await registry.onModuleInit()
  }

  /** Warnings whose metadata names the OTel reason. */
  const otelWarnings = (): unknown[] =>
    warnSpy.mock.calls.filter(
      (call) => (call[3] as { reason?: string } | undefined)?.reason === 'OTEL_API_UNAVAILABLE'
    )

  it(/*
   * REGRESSION — a missing `@opentelemetry/api` used to be indistinguishable from
   * "no active span": both produce entries with no `traceId`. The consumer asked
   * for auto-injection, so the failure to deliver it has to be visible at boot,
   * exactly once, or the misconfiguration is invisible for the life of the
   * process.
   */
  'warns once when auto-injection is on and the OTel API is unavailable', async () => {
    mockedDetect.mockReturnValue(undefined)

    await boot({ service: { name: 'app', version: '1.0.0' } })

    expect(otelWarnings()).toHaveLength(1)
    // The whole message and the whole metadata object, not a fragment: this line
    // is the only signal that correlation was asked for and cannot be delivered,
    // and half of it going missing would still read as a warning while saying
    // nothing actionable.
    expect(warnSpy).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_WARNING,
      'Trace-context auto-injection is enabled but @opentelemetry/api could not be ' +
        'resolved — traceId and spanId will be absent from every entry',
      undefined,
      { reason: 'OTEL_API_UNAVAILABLE', shouldAutoInjectTraceContext: true }
    )
  })

  it(/*
   * Nothing was asked for, so nothing is missing. A logger with auto-injection
   * off must not nag about an optional peer it was never going to use.
   */
  'stays silent when auto-injection is disabled', async () => {
    mockedDetect.mockReturnValue(undefined)

    await boot({
      service: { name: 'app', version: '1.0.0' },
      otel: { shouldAutoInjectTraceContext: false }
    })

    expect(otelWarnings()).toHaveLength(0)
  })

  it(/*
   * The peer resolves, so auto-injection will work — warning here would train
   * consumers to ignore the signal.
   */
  'stays silent when the OTel API resolves', async () => {
    mockedDetect.mockReturnValue({ getActiveSpan: () => undefined })

    await boot({ service: { name: 'app', version: '1.0.0' } })

    expect(otelWarnings()).toHaveLength(0)
  })
})
