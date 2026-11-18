/**
 * Verifies DestinationRegistry shutdown: the shutdown entry, reverse-order teardown, stderr reports
 * of a failed teardown (escaped, and cut when long), and teardown or startup continuing past
 * destinations whose cause, name or minLevel cannot be read.
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

/** The structured line a failed shutdown wrote to stderr, parsed, for the destination named. */
function shutdownLine(
  spy: jest.SpyInstance,
  destination: string
): { raw: string; parsed: Record<string, unknown> } | undefined {
  const raw = spy.mock.calls
    .map((call) => String(call[0]))
    .find(
      (line) =>
        line.includes('LOGGER_DESTINATION_SHUTDOWN_FAILED') &&
        line.includes(`"destination":"${destination}"`)
    )
  return raw === undefined ? undefined : { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
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

  describe('onApplicationShutdown', () => {
    /*
     * REGRESSION — audit finding D-1. `LOGGER_SHUTDOWN_OK` was declared in the
     * reserved catalog and never written. It is the bookend to
     * `LOGGER_BOOTSTRAP_OK`: its absence in a log stream is how an operator
     * tells a graceful shutdown from a killed process. Message and metadata are
     * asserted, and the emission must happen BEFORE any sink is torn down —
     * an entry written after the destinations closed would have nowhere to go.
     */
    it('emits LOGGER_SHUTDOWN_OK before tearing any destination down', async () => {
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

    /*
     * Destinations must shut down in REVERSE registration order so the
     * first-registered sink (typically stdout) closes last.
     */
    it('shuts down active destinations in reverse order', async () => {
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

    /*
     * The detail of a failed shutdown without a stack is the thrown value's message, and that
     * text is cut at the same limit as every message the logger writes.
     */
    it('cuts the message of a destination that failed to shut down without a stack', async () => {
      const failing = makeDestination('failing', {
        onInit: jest.fn(),
        onShutdown: jest.fn(() => {
          throw Object.assign(new Error('x'.repeat(30_000)), { stack: undefined })
        })
      })
      const registry = new DestinationRegistry([failing], logger, options, health)
      await registry.onModuleInit()
      stderrSpy.mockClear()

      await registry.onApplicationShutdown()

      const line = stderrSpy.mock.calls[0]?.[0] as string
      expect(line.length).toBeLessThan(100_000)
      expect(line).toContain('x'.repeat(16_384) + '…[truncated]')
    })

    /*
     * The line of a failed shutdown carries the type and the message of the thrown error and never
     * its stack: a stack can be megabytes long when the name and the message of the error are
     * themselves errors, and it is host text written whole.
     */
    it('does not write the stack of a destination that failed to shut down', async () => {
      const failing = makeDestination('failing', {
        onInit: jest.fn(),
        onShutdown: jest.fn(() => {
          throw Object.assign(new Error('close failed'), {
            stack: `Error: close failed\n${'a'.repeat(3_000_000)}`
          })
        })
      })
      const registry = new DestinationRegistry([failing], logger, options, health)
      await registry.onModuleInit()
      stderrSpy.mockClear()

      await registry.onApplicationShutdown()

      const line = shutdownLine(stderrSpy, 'failing')
      expect(line?.raw.length).toBeLessThan(1_000)
      expect(line?.raw).not.toContain('aaaaaaaaaa')
      expect(line?.parsed['err']).toEqual({ type: 'Error', message: 'close failed' })
    })

    /*
     * A destination without an onShutdown hook must not break graceful shutdown.
     */
    it('tolerates a destination without an onShutdown hook', async () => {
      const hookless = makeDestination('hookless', { onInit: jest.fn() })
      const registry = new DestinationRegistry([hookless], logger, options, health)
      await registry.onModuleInit()

      await expect(registry.onApplicationShutdown()).resolves.toBeUndefined()
    })

    /*
     * If a destination's onShutdown throws an Error, the failure must fall back
     * to process.stderr.write using the error's stack (or message when no stack).
     */
    it('falls back to process.stderr.write when onShutdown throws an Error', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const boom = makeDestination('boom', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(new Error('shutdown-fail'))
      })
      const registry = new DestinationRegistry([boom], logger, options, health)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(shutdownLine(stderrSpy, 'boom')?.parsed).toMatchObject({
        level: 'error',
        logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_SHUTDOWN_FAILED,
        destination: 'boom',
        err: { type: 'Error', message: 'shutdown-fail' },
        msg: expect.stringContaining('failed to shut down')
      })
      expect(shutdownLine(stderrSpy, 'boom')?.parsed['msg']).not.toContain('boom')
      stderrSpy.mockRestore()
    })

    /*
     * The message of the error that failed `onShutdown` passes the censor of the module options, as
     * the message of an entry does, so a credential in it is not written to stderr.
     */
    it('writes the message of a shutdown failure as the options censor it', async () => {
      const censoring = applyDefaults({
        service: { name: 'app', version: '1.0.0' },
        redactPaths: ['message']
      })
      const leaking = makeDestination('leaking', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(new Error('connect to https://user:SECRET@host'))
      })
      const registry = new DestinationRegistry([leaking], logger, censoring, health)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).not.toContain('SECRET')
      expect(shutdownLine(stderrSpy, 'leaking')?.parsed['err']).toEqual({
        type: 'Error',
        message: '[REDACTED]'
      })
    })

    /*
     * REGRESSION — a cause whose own READ throws must not abort the teardown of
     * the destinations still queued behind it. The report used to coerce above
     * its guard: `String(cause)` on a value with a throwing `Symbol.toPrimitive`,
     * and the `stack`/`message` reads on an Error with hostile getters, both throw
     * from inside the `catch` that exists to keep one bad sink from mattering — so
     * the throw escaped `onApplicationShutdown` and every remaining destination
     * lost its flush.
     *
     * Asserted on the SECOND destination actually shutting down, not merely on the
     * absence of a throw: the point of the guard is that teardown continues.
     */
    it('keeps tearing down when the thrown cause cannot even be read', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const hostile = {
        get stack(): string {
          throw new Error('stack getter exploded')
        },
        get message(): string {
          throw new Error('message getter exploded')
        },
        name: 'Error'
      }
      Object.setPrototypeOf(hostile, Error.prototype)
      // Registered first, so it shuts down LAST in reverse order — the failure
      // therefore happens while `survivor` still has to be closed.
      const survivor = makeDestination('survivor', { onInit: jest.fn(), onShutdown: jest.fn() })
      const poison = makeDestination('poison', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(hostile)
      })
      const registry = new DestinationRegistry([survivor, poison], logger, options, health)
      await registry.onModuleInit()

      await expect(registry.onApplicationShutdown()).resolves.toBeUndefined()

      expect(survivor.onShutdown).toHaveBeenCalled()
      expect(shutdownLine(stderrSpy, 'poison')?.parsed['err']).toEqual({
        type: 'UnknownError',
        message: 'unreadable value'
      })
      stderrSpy.mockRestore()
    })

    /*
     * REGRESSION — the SHUTDOWN report escapes control characters, and that is
     * asserted rather than assumed. Every other shutdown test uses plain ASCII, so
     * a report that wrote the message verbatim would leave them all green while an
     * attacker-supplied message drove the operator's terminal.
     */
    it('escapes control characters in the message of the shutdown report', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const hostile = new Error('boom \u001b[31mevil\u0085 text')
      const dest = makeDestination('ansi', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(hostile)
      })
      const registry = new DestinationRegistry([dest], logger, options, health)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      const line = shutdownLine(stderrSpy, 'ansi')?.raw
      // Asserted POSITIVELY on the escaped form, not only on the absence of the raw
      // one: `not.toContain` alone is satisfied by an empty line, so it cannot tell
      // "escaped correctly" from "nothing was emitted".
      // The escape character is written as the text `\u001b` and the NEL as the line terminator
      // `\n`, and JSON then escapes the backslash of each: two backslashes in the raw line.
      expect(line).toContain('boom \\\\u001b[31mevil\\\\n text')
      expect(line).not.toContain('\u001b')
      expect(line).not.toContain('\u0085')
      stderrSpy.mockRestore()
    })

    /*
     * REGRESSION — a throwing `minLevel` getter must not abort bootstrap either.
     * `effectiveLevelOf` reads it on BOTH branches of the init loop, including
     * inside the catch that exists so a failing destination cannot stop the
     * application from starting: an escape there took the app down at start-up and
     * stranded every destination after it. `readonly minLevel?: LogLevel` does not
     * stop a consumer implementing it as a getter.
     *
     * Asserted on the LATER destination initializing, not merely on the absence of
     * a throw — continuing the loop is the property that matters.
     */
    it('still boots when a destination cannot report its own minLevel', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const poison = makeDestination('poison', { onInit: jest.fn() })
      Object.defineProperty(poison, 'minLevel', {
        get() {
          throw new Error('minLevel getter exploded')
        }
      })
      const later = makeDestination('later', { onInit: jest.fn() })
      const registry = new DestinationRegistry([poison, later], logger, options, health)

      await expect(registry.onModuleInit()).resolves.toBeUndefined()

      expect(later.onInit).toHaveBeenCalled()
      stderrSpy.mockRestore()
    })

    /*
     * REGRESSION — a throwing `name` getter must not abort BOOTSTRAP either. The
     * init reporter read the name at its call site, inside the catch that exists
     * so a failing destination cannot stop the application from starting; the
     * throw escaped `onModuleInit` and did exactly what that catch forbids.
     */
    it('still boots when a failing destination cannot report its own name', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const healthy = makeDestination('healthy', { onInit: jest.fn() })
      const poison = makeDestination('poison', {
        onInit: jest.fn().mockRejectedValue(new Error('init-fail'))
      })
      Object.defineProperty(poison, 'name', {
        get() {
          throw new Error('name getter exploded')
        }
      })
      const registry = new DestinationRegistry([healthy, poison], logger, options, health)

      await expect(registry.onModuleInit()).resolves.toBeUndefined()

      expect(healthy.onInit).toHaveBeenCalled()
      // The emitted record is PARSED and its fields asserted, not probed for
      // existence: `toBeDefined()` would pass on any line that happened to contain
      // the word, including one emitted under the wrong key or without the
      // fallback name ever being serialized.
      const report: unknown = JSON.parse(
        stderrSpy.mock.calls.map((c) => String(c[0])).find((c) => c.includes('unknown')) ?? '{}'
      )
      expect(report).toMatchObject({
        logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
        destination: 'unknown',
        err: { type: 'Error', message: 'init-fail' }
      })
      stderrSpy.mockRestore()
    })

    /*
     * REGRESSION — a newline-bearing cause WITHOUT a stack must not forge a second
     * stderr record. `escapeControlCharacters` preserves newlines on purpose, since
     * a stack is legitimately multi-line; routing a `message` or a non-Error value
     * through it let `failed\n[forged entry]` become a line an operator reads as a
     * genuine one. Single-line fields go through `toSingleLineMessage` instead.
     *
     * Asserted on the emitted text being ONE line, not merely on the escape being
     * present.
     */
    it('never lets a newline in a stackless cause open a second stderr line', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stackless = new Error('failed\n[forged entry]')
      delete stackless.stack
      const dest = makeDestination('forge', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(stackless)
      })
      const registry = new DestinationRegistry([dest], logger, options, health)
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      const line = shutdownLine(stderrSpy, 'forge')
      // The message holds the two-character text `\n`, which JSON writes with a second backslash.
      expect(line?.raw).toContain('failed\\\\n[forged entry]')
      // Exactly one terminating newline, and none inside: the record cannot be split.
      expect(line?.raw.endsWith('\n')).toBe(true)
      expect(line?.raw.slice(0, -1)).not.toContain('\n')
      expect((line?.parsed['err'] as { message: string }).message).toBe('failed\\n[forged entry]')
      stderrSpy.mockRestore()
    })

    /*
     * REGRESSION — the destination's own `name` is read inside the guard too.
     * `readonly name: string` does not stop a consumer implementing it as a
     * getter, and reading it at the call site would put it back inside the
     * `catch`, where a throw aborts the remaining teardown exactly as a hostile
     * cause would. Guarded separately from the detail, so one unreadable value
     * does not cost the other.
     */
    it('keeps tearing down when the destination name itself cannot be read', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const survivor = makeDestination('survivor', { onInit: jest.fn(), onShutdown: jest.fn() })
      const poison = makeDestination('named', {
        onInit: jest.fn(),
        onShutdown: jest.fn().mockRejectedValue(new Error('shutdown-fail'))
      })
      Object.defineProperty(poison, 'name', {
        get() {
          throw new Error('name getter exploded')
        }
      })
      const registry = new DestinationRegistry([survivor, poison], logger, options, health)
      await registry.onModuleInit()

      await expect(registry.onApplicationShutdown()).resolves.toBeUndefined()

      expect(survivor.onShutdown).toHaveBeenCalled()
      // The name is lost, the detail is not — that is the point of guarding them
      // separately rather than together.
      expect(shutdownLine(stderrSpy, 'unknown')?.parsed['err']).toEqual({
        type: 'Error',
        message: 'shutdown-fail'
      })
      stderrSpy.mockRestore()
    })

    /*
     * When the thrown cause is a non-Error value (e.g. a string), String(cause)
     * must be used as the detail — covers the instanceof-false branch.
     */
    it('falls back to process.stderr.write when onShutdown throws a non-Error', async () => {
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

    /*
     * When the Error has no stack (e.g. stripped by a transpiler), the message
     * must be used as the detail — covers the stack ?? message branch.
     */
    it('uses error.message when stack is absent', async () => {
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
})
