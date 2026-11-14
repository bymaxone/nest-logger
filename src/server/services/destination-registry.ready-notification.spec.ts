/**
 * Verifies the onRegistryReady notification sent at init: the delivered-elsewhere status each
 * destination receives (by destination level), throwing and async hooks not aborting init, and
 * the stderr wording used when a hook fails.
 *
 * Layer: server/services, tests.
 */
jest.mock('../utils/otel-detector', () => ({
  ...jest.requireActual<typeof import('../utils/otel-detector')>('../utils/otel-detector'),
  detectOtelTraceApi: jest.fn()
}))

import pino from 'pino'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { applyDefaults } from '../config/default-options'

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
        // The healthy one is NOT its own "somewhere else": nothing but itself
        // received what it received.
        { name: 'healthy', status: { heldEntriesDeliveredElsewhere: false } },
        { name: 'failing', status: { heldEntriesDeliveredElsewhere: true } }
      ])
      stderrSpy.mockRestore()
    })

    it(/*
     * With nothing live, the flag says so — which is what tells a buffering
     * destination its held entries exist nowhere else and must go out degraded
     * rather than be discarded.
     */
    'reports no proven delivery when every destination failed', async () => {
      const failing = {
        ...makeDestination('failing'),
        onInit: jest.fn().mockRejectedValue(new Error('nope')),
        onRegistryReady: jest.fn()
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry([failing], logger, options, health).onModuleInit()

      expect(failing.onRegistryReady).toHaveBeenCalledWith({
        heldEntriesDeliveredElsewhere: false
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
     * REGRESSION — the readiness reporter reads the destination's `name` under a
     * guard, like the init, write and shutdown reporters do. This was the one
     * changed call site without such a test: every other hook case uses a plain
     * name, so replacing `safeDestinationName(destination)` with
     * `destination.name` would have passed them all while a throwing getter
     * escaped this catch and cost the REMAINING destinations their notification
     * and the bootstrap entry.
     *
     * Asserted on the later destination still being notified, not merely on the
     * absence of a throw.
     */
    'still notifies the rest when a failing hook destination cannot report its name', async () => {
      const hostile = {
        ...makeDestination('hostile'),
        onRegistryReady: jest.fn(() => {
          throw new Error('hook exploded')
        })
      }
      Object.defineProperty(hostile, 'name', {
        get() {
          throw new Error('name getter exploded')
        }
      })
      const later = { ...makeDestination('later'), onRegistryReady: jest.fn() }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await expect(
        new DestinationRegistry([hostile, later], logger, options, health).onModuleInit()
      ).resolves.toBeUndefined()

      expect(later.onRegistryReady).toHaveBeenCalled()
      const report: unknown = JSON.parse(
        stderrSpy.mock.calls.map((c) => String(c[0])).find((c) => c.includes('unknown')) ?? '{}'
      )
      expect(report).toMatchObject({
        logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
        destination: 'unknown',
        err: { type: 'Error', message: 'hook exploded' }
      })
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
      // BOTH halves of the concatenated message: the second carries the
      // operator-facing consequence, and emptying it left a mutant alive.
      expect(line).toContain('initialized successfully and keeps receiving entries')
      expect(line).toContain('holding from before init')
      expect(line).not.toContain('will receive no entries')
      stderrSpy.mockRestore()
    })

    it(/*
     * REGRESSION — the SAME reporter is reached for a destination that already
     * failed to initialize, and the healthy wording would contradict the report
     * it just received. The loop notifies every registered destination by design,
     * so one message cannot be true for both states. Found by Copilot in a review
     * body rather than an inline thread.
     */
    'words a hook failure differently for an already-failed destination', async () => {
      const failed = {
        ...makeDestination('failed'),
        onInit: jest.fn().mockRejectedValue(new Error('init died')),
        onRegistryReady: jest.fn(() => {
          throw new Error('hook exploded')
        })
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry([failed], logger, options, health).onModuleInit()

      const line = stderrSpy.mock.calls.map(([l]) => String(l)).join('')
      expect(line).toContain('had already failed to initialize and receives no entries')
      expect(line).toContain('still holding is lost')
      expect(line).not.toContain('keeps receiving entries')
      stderrSpy.mockRestore()
    })

    it(/*
     * REGRESSION — an ASYNC hook is awaited, and its rejection is contained.
     * TypeScript accepts an `async` implementation where a void-returning member
     * is declared, so a hook that was not awaited would reject into nothing and
     * let the bootstrap entry be emitted before the buffer it was resolving had
     * been drained. Found by Copilot on the hook's own signature.
     */
    'awaits an async hook and contains its rejection', async () => {
      const order: string[] = []
      const slow = {
        ...makeDestination('slow'),
        onRegistryReady: jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          order.push('hook')
        })
      }
      const rejecting = {
        ...makeDestination('rejecting'),
        onRegistryReady: jest.fn(async () => {
          await Promise.reject(new Error('async hook exploded'))
        })
      }
      infoSpy.mockImplementation(() => {
        order.push('bootstrap')
      })
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await expect(
        new DestinationRegistry([slow, rejecting], logger, options, health).onModuleInit()
      ).resolves.toBeUndefined()

      // The slow hook finished BEFORE the bootstrap entry went out.
      expect(order).toEqual(['hook', 'bootstrap'])
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('async hook exploded'))
      stderrSpy.mockRestore()
    })

    it(/*
     * REGRESSION — a `minLevel` BELOW the module level does not widen what a
     * destination receives: Pino filters at the instance level before
     * `pino.multistream` sees an entry. Recording the raw `minLevel` understated
     * delivery and produced a duplicate raw drain out of arithmetic rather than
     * any real gap — with a global `error`, a healthy sink at `info` and a failed
     * pretty at `trace`, both in fact received the same entries. Found by Copilot
     * in a suppressed review body.
     */
    'compares on the stricter of the module and destination levels', async () => {
      const strictOptions = applyDefaults({
        service: { name: 'app', version: '1.0.0' },
        level: 'error'
      })
      const healthy = { ...makeDestination('healthy'), minLevel: 'info' as const }
      const permissive = {
        ...makeDestination('permissive'),
        minLevel: 'trace' as const,
        onInit: jest.fn().mockRejectedValue(new Error('nope')),
        onRegistryReady: jest.fn()
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

      await new DestinationRegistry(
        [healthy, permissive],
        logger,
        strictOptions,
        health
      ).onModuleInit()
      stderrSpy.mockRestore()

      // Both are gated at `error` by the instance, so the healthy sink DID take
      // everything the failed one would have taken.
      expect(permissive.onRegistryReady).toHaveBeenCalledWith({
        heldEntriesDeliveredElsewhere: true
      })
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

      expect(infoSink.onRegistryReady).toHaveBeenCalledWith({
        heldEntriesDeliveredElsewhere: false
      })
    })
  })
})
