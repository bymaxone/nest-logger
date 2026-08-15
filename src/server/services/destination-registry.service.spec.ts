jest.mock('../utils/otel-detector', () => ({
  ...jest.requireActual<typeof import('../utils/otel-detector')>('../utils/otel-detector'),
  detectOtelTraceApi: jest.fn()
}))

import pino from 'pino'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { applyDefaults } from '../config/default-options'
import { detectOtelTraceApi } from '../utils/otel-detector'

import { DestinationHealth } from './destination-health.service'
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
  let stderrSpy: jest.SpyInstance
  let health: DestinationHealth

  beforeEach(() => {
    // A real but silent Pino instance avoids fabricating a Logger mock (cast-free).
    logger = new PinoLoggerService(pino({ enabled: false }))
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation(() => undefined)
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined)
    // Init failures are reported to stderr, never through the logger — the whole
    // point of the fix, since the logger's own sinks are what may have failed.
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /** The single stderr report emitted for a failed destination, parsed. */
  function reportedInitFailure(): Record<string, unknown> {
    const line = stderrSpy.mock.calls[0]?.[0] as string
    return JSON.parse(line) as Record<string, unknown>
  }

  describe('onModuleInit', () => {
    it(/*
     * Every registered destination must be initialized and marked active —
     * including one with no onInit hook (the optional-chain must not break it).
     */
    'initializes every destination and marks them active', async () => {
      const withHook = makeDestination('with-hook', { onInit: jest.fn() })
      const hookless = makeDestination('hookless')
      const registry = new DestinationRegistry([withHook, hookless], logger, options, health)

      await registry.onModuleInit()

      expect(withHook.onInit).toHaveBeenCalledTimes(1)
      expect(registry.getActive()).toEqual([withHook, hookless])
    })

    it(/*
     * A destination whose onInit throws must be dropped from the active set and
     * reported as LOGGER_DESTINATION_INIT_FAILED — without aborting boot or
     * preventing the healthy destinations from initializing.
     */
    'skips a failing destination and reports it without blocking the others', async () => {
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const healthy = makeDestination('healthy', { onInit: jest.fn() })
      const registry = new DestinationRegistry([boom, healthy], logger, options, health)

      await registry.onModuleInit()

      expect(registry.getActive()).toEqual([healthy])
      expect(reportedInitFailure()).toMatchObject({
        level: 'error',
        logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
        destination: 'boom',
        err: { type: 'Error', message: 'init-fail' }
      })
    })

    it(/*
     * The human-readable message is the operator-facing half of the report: it
     * has to name the destination, say that it will receive nothing, AND state
     * the stdout fallback — that last sentence is what tells a developer staring
     * at raw NDJSON where it is coming from. Asserted because mutation testing
     * showed the message could be emptied entirely without a test noticing.
     */
    'explains the consequence and the fallback in the report message', async () => {
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const registry = new DestinationRegistry([boom], logger, options, health)

      await registry.onModuleInit()

      const msg = reportedInitFailure()['msg']
      expect(msg).toContain('"boom" failed to initialize')
      expect(msg).toContain('will receive no entries')
      expect(msg).toContain('fall back to raw NDJSON on stdout')
    })

    it(/*
     * REGRESSION — the init failure must NOT be reported through the logger. Doing
     * so routes the explanation into the very sink set that just failed: with
     * `destinations` replacing the default stdout sink, a single failing sink
     * produced an application that booted, ran, exited 0 and wrote nothing
     * anywhere — with the diagnostic naming the cause delivered into the dead sink.
     */
    'reports the failure to stderr and never through the logger', async () => {
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const registry = new DestinationRegistry([boom], logger, options, health)

      await registry.onModuleInit()

      expect(stderrSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it(/*
     * A failed destination must be marked in the shared health record — that is
     * what removes it from the write fan-out, which the multistream (built before
     * any onInit ran) cannot do for itself.
     */
    'marks a failed destination in the shared health record', async () => {
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const healthy = makeDestination('healthy', { onInit: jest.fn() })
      const registry = new DestinationRegistry([boom, healthy], logger, options, health)

      await registry.onModuleInit()

      expect(health.isFailed(boom)).toBe(true)
      expect(health.isFailed(healthy)).toBe(false)
      // A healthy sink exists, so nothing needs rescuing.
      expect(health.shouldRescue(boom)).toBe(false)
    })

    it(/*
     * When EVERY destination fails, one must be elected to rescue entries as raw
     * NDJSON — and the election must happen before announceBootstrap() runs, or
     * the bootstrap entries (including LOGGER_BOOTSTRAP_WARNING, the signal that
     * PII redaction was disabled) are lost exactly when the configuration is
     * already known to be broken.
     */
    'elects a rescuer before announcing bootstrap when every destination fails', async () => {
      const electedDuringAnnounce: boolean[] = []
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      infoSpy.mockImplementation(() => {
        electedDuringAnnounce.push(health.shouldRescue(boom))
      })
      const registry = new DestinationRegistry([boom], logger, options, health)

      await registry.onModuleInit()

      expect(health.shouldRescue(boom)).toBe(true)
      expect(electedDuringAnnounce).toEqual([true])
    })

    it(/*
     * A destination's effective level (minLevel when set, otherwise the module
     * level) must be what is recorded, since the rescuer is elected by level.
     */
    'records the destination minLevel as its effective level', async () => {
      const quiet: ILogDestination = {
        ...makeDestination('quiet', {
          onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
        }),
        minLevel: 'error'
      }
      const loud = makeDestination('loud', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const registry = new DestinationRegistry([quiet, loud], logger, options, health)

      await registry.onModuleInit()

      // `loud` has no minLevel, so it inherits the module level (debug) and wins
      // the election over `quiet`'s error — despite being registered second.
      expect(health.shouldRescue(loud)).toBe(true)
      expect(health.shouldRescue(quiet)).toBe(false)
    })

    it(/*
     * A non-Error thrown from onInit (e.g. a bare string) must be coerced into a
     * serializable envelope so the stderr report is always valid NDJSON.
     */
    'coerces a non-Error onInit failure into a serializable envelope', async () => {
      const weird = makeDestination('weird', {
        onInit: jest.fn().mockRejectedValue('string-failure')
      })
      const registry = new DestinationRegistry([weird], logger, options, health)

      await registry.onModuleInit()

      expect(reportedInitFailure()).toMatchObject({
        err: { type: 'UnknownError', message: 'string-failure' }
      })
    })

    it(/*
     * REGRESSION — the never-throw contract has to cover READING the rejected
     * value, not just writing the report. A value whose `toString` throws was
     * coerced outside the guard, so the exception escaped the registry's own
     * catch and aborted application bootstrap: the failure handler became a
     * harder failure than the one it was handling.
     */
    'survives a rejection value that throws while being coerced', async () => {
      const hostile = {
        toString(): string {
          throw new Error('hostile toString')
        }
      }
      const boom = makeDestination('boom', { onInit: jest.fn().mockRejectedValue(hostile) })
      const registry = new DestinationRegistry([boom], logger, options, health)

      await expect(registry.onModuleInit()).resolves.toBeUndefined()
      // Still dropped from the fan-out — the unreadable value must not make the
      // sink look healthy.
      expect(health.isFailed(boom)).toBe(true)
    })

    it(/*
     * Control characters in a consumer-named destination must not reach a
     * terminal unescaped. `JSON.stringify` escapes C0 and nothing else, so DEL,
     * C1 (U+0085 NEL), U+2028 and U+2029 would survive verbatim into a line an
     * operator reads — enough to forge a rendered entry.
     */
    'escapes control characters in the reported destination name', async () => {
      const sneaky = makeDestination('evil\u0085forged', {
        onInit: jest.fn().mockRejectedValue(new Error('nope'))
      })
      const registry = new DestinationRegistry([sneaky], logger, options, health)

      await registry.onModuleInit()

      const line = stderrSpy.mock.calls[0]?.[0] as string
      expect(line).not.toContain('\u0085')
      expect(reportedInitFailure()['destination']).toContain('evil')
    })

    it(/*
     * Reporting a broken sink must never become the crash it exists to prevent —
     * stderr itself can be a closed pipe (`node app | head`), and EPIPE there must
     * be swallowed rather than aborting bootstrap.
     */
    'survives stderr itself failing', async () => {
      stderrSpy.mockImplementation(() => {
        throw new Error('EPIPE')
      })
      const boom = makeDestination('boom', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      const registry = new DestinationRegistry([boom], logger, options, health)

      await expect(registry.onModuleInit()).resolves.toBeUndefined()
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
      const registry = new DestinationRegistry([destination], logger, options, health)
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
      const registry = new DestinationRegistry([first, second], logger, options, health)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(order).toEqual(['second', 'first'])
    })

    it(/*
     * A destination without an onShutdown hook must not break graceful shutdown.
     */
    'tolerates a destination without an onShutdown hook', async () => {
      const hookless = makeDestination('hookless', { onInit: jest.fn() })
      const registry = new DestinationRegistry([hookless], logger, options, health)
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
      const registry = new DestinationRegistry([boom], logger, options, health)
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
      const registry = new DestinationRegistry([boom], logger, options, health)
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
      const registry = new DestinationRegistry([boom], logger, options, health)
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
      const registry = new DestinationRegistry([makeDestination('a')], logger, options, health)
      expect(registry.getActive()).toEqual([])
    })
  })

  describe('onRegistryReady notification', () => {
    it(/*
     * REGRESSION (1.2.6) — a destination holding pre-init entries must be told
     * whether anyone else can deliver them, and told AFTER every onInit settled.
     * Deciding alone made a supported stdout+pretty pair print each boot entry
     * twice. The FAILED destination is notified too — it is precisely the one
     * still holding entries.
     */
    'tells every registered destination whether a sink survived', async () => {
      const healthy = makeDestination('healthy')
      const failing = {
        ...makeDestination('failing'),
        onInit: jest.fn().mockRejectedValue(new Error('nope'))
      }
      const seen: { name: string; status: Record<string, boolean> }[] = []
      const notify =
        (name: string) =>
        (status: Record<string, boolean>): void => {
          seen.push({ name, status })
        }
      const withHook = [
        { ...healthy, onRegistryReady: notify('healthy') },
        { ...failing, onRegistryReady: notify('failing') }
      ]
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry(withHook, logger, options, health).onModuleInit()

      expect(seen).toEqual([
        {
          name: 'healthy',
          status: {
            heldEntriesDeliveredElsewhere: true,
            hasHealthySink: true,
            isElectedRescuer: false
          }
        },
        {
          name: 'failing',
          status: {
            heldEntriesDeliveredElsewhere: true,
            hasHealthySink: true,
            isElectedRescuer: false
          }
        }
      ])
      stderrSpy.mockRestore()
    })

    it(/*
     * With nothing live, the flag says so — which is what tells a buffering
     * destination its held entries exist nowhere else and must go out degraded
     * rather than be discarded.
     */
    'reports no healthy sink when every destination failed', async () => {
      const failing = {
        ...makeDestination('failing'),
        onInit: jest.fn().mockRejectedValue(new Error('nope')),
        onRegistryReady: jest.fn()
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry([failing], logger, options, health).onModuleInit()

      expect(failing.onRegistryReady).toHaveBeenCalledWith({
        heldEntriesDeliveredElsewhere: false,
        hasHealthySink: false,
        isElectedRescuer: true
      })
      stderrSpy.mockRestore()
    })

    it(/*
     * A destination that throws from the hook must not cost the bootstrap entry
     * or the remaining destinations. Failing at a courtesy notification cannot be
     * allowed to be more expensive than the notification was worth.
     */
    'contains a throwing hook and still notifies the rest', async () => {
      const hostile = {
        ...makeDestination('hostile'),
        onRegistryReady: jest.fn(() => {
          throw new Error('hook exploded')
        })
      }
      const later = { ...makeDestination('later'), onRegistryReady: jest.fn() }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await expect(
        new DestinationRegistry([hostile, later], logger, options, health).onModuleInit()
      ).resolves.toBeUndefined()

      expect(later.onRegistryReady).toHaveBeenCalled()
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('hook exploded'))
      stderrSpy.mockRestore()
    })

    it(/*
     * REGRESSION — a hook failure must NOT reuse the init-failure message. By this
     * point `onInit` already succeeded and the destination is in the active set,
     * so telling an operator it "will receive no entries" sends them looking for
     * a silence that is not there. Reported by Copilot against the first version
     * of this loop, which shared the init reporter.
     */
    'reports a hook failure as still-active rather than as an init failure', async () => {
      const hostile = {
        ...makeDestination('hostile'),
        onRegistryReady: jest.fn(() => {
          throw new Error('hook exploded')
        })
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry([hostile], logger, options, health).onModuleInit()

      const line = stderrSpy.mock.calls.map(([l]) => String(l)).join('')
      expect(line).toContain('threw from onRegistryReady')
      expect(line).toContain('remains active')
      // BOTH halves of the concatenated message: the second one carries the
      // operator-facing consequence, and emptying it left a mutant alive.
      expect(line).toContain('keeps receiving entries')
      expect(line).toContain('holding from before init')
      expect(line).not.toContain('will receive no entries')
      stderrSpy.mockRestore()
    })

    it(/*
     * The readiness facts are computed PER destination, not shared: a sink whose
     * level sits above another's did not receive what the lower one received.
     * Without this, one status object for the whole fleet would tell an `info`
     * destination its entries were delivered by an `error` sink.
     */
    'computes delivery per destination level', async () => {
      const errorSink = { ...makeDestination('error-sink'), minLevel: 'error' as const }
      // The info sink FAILS: it is the one holding entries, and the question is
      // whether the surviving `error` sink received them. It did not — multistream
      // filters per stream — so it must be told so.
      const infoSink = {
        ...makeDestination('info-sink'),
        minLevel: 'info' as const,
        onInit: jest.fn().mockRejectedValue(new Error('nope')),
        onRegistryReady: jest.fn()
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry([errorSink, infoSink], logger, options, health).onModuleInit()
      stderrSpy.mockRestore()

      expect(infoSink.onRegistryReady).toHaveBeenCalledWith(
        expect.objectContaining({ heldEntriesDeliveredElsewhere: false, hasHealthySink: true })
      )
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
    const registry = new DestinationRegistry(
      [],
      logger,
      applyDefaults(overrides),
      new DestinationHealth()
    )
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
