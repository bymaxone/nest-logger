import pino from 'pino'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

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
  let logger: PinoLoggerService
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    // A real but silent Pino instance avoids fabricating a Logger mock (cast-free).
    logger = new PinoLoggerService(pino({ enabled: false }))
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation(() => undefined)
  })

  describe('onModuleInit', () => {
    it(/*
     * Every registered destination must be initialized and marked active —
     * including one with no onInit hook (the optional-chain must not break it).
     */
    'initializes every destination and marks them active', async () => {
      const withHook = makeDestination('with-hook', { onInit: jest.fn() })
      const hookless = makeDestination('hookless')
      const registry = new DestinationRegistry([withHook, hookless], logger)

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
      const registry = new DestinationRegistry([boom, healthy], logger)

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
      const registry = new DestinationRegistry([weird], logger)

      await registry.onModuleInit()

      const reportedError = errorSpy.mock.calls[0]?.[1]
      expect(reportedError).toBeInstanceOf(Error)
      expect(reportedError).toHaveProperty('message', 'string-failure')
    })
  })

  describe('onApplicationShutdown', () => {
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
      const registry = new DestinationRegistry([first, second], logger)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(order).toEqual(['second', 'first'])
    })

    it(/*
     * A destination without an onShutdown hook must not break graceful shutdown.
     */
    'tolerates a destination without an onShutdown hook', async () => {
      const hookless = makeDestination('hookless', { onInit: jest.fn() })
      const registry = new DestinationRegistry([hookless], logger)
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
      const registry = new DestinationRegistry([boom], logger)
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
      const registry = new DestinationRegistry([boom], logger)
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
      const registry = new DestinationRegistry([boom], logger)
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
      const registry = new DestinationRegistry([makeDestination('a')], logger)
      expect(registry.getActive()).toEqual([])
    })
  })
})
