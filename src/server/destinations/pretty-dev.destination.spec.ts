import { PrettyDevDestination } from './pretty-dev.destination'
import type { PrettyViewOptions } from './pretty-dev.destination'

/** A syntactically valid Pino NDJSON line `pino-pretty` can parse and format. */
const VALID_NDJSON_LINE =
  JSON.stringify({ level: 30, time: 1_700_000_000_000, msg: 'hello-pretty' }) + '\n'

/** Resolve after a short delay so the async pino-pretty transform flushes. */
function flushIo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

describe('PrettyDevDestination', () => {
  describe('constructor', () => {
    it(/*
     * With no options the destination must accept every level (minLevel
     * undefined), so the default dev sink never silently drops entries.
     */
    'leaves minLevel undefined by default', () => {
      const dest = new PrettyDevDestination()
      expect(dest.minLevel).toBeUndefined()
      expect(dest.name).toBe('pretty-dev')
    })

    it(/*
     * A provided minLevel must be retained so the multi-stream wiring can gate
     * this destination independently of the global level.
     */
    'retains a provided minLevel', () => {
      const dest = new PrettyDevDestination({ minLevel: 'warn' })
      expect(dest.minLevel).toBe('warn')
    })
  })

  describe('onInit', () => {
    it(/*
     * When pino-pretty resolves, onInit must build the transform without
     * throwing — the happy path every dev environment hits.
     */
    'builds the pretty transform when pino-pretty is available', async () => {
      const dest = new PrettyDevDestination()
      await expect(dest.onInit()).resolves.toBeUndefined()
      await dest.onShutdown()
    })

    it(/*
     * The library installs NO stdout `'error'` listener of its own here, and this
     * pins that as a decision rather than leaving it to drift. pino-pretty's
     * `build({ destination: process.stdout })` attaches two listeners itself, and
     * a child process piped to a closed reader survived and exited 0 with nothing
     * from this library on the stream — so a guard here would be code whose need
     * is disproven.
     *
     * What is asserted is the weaker, durable half: at least one listener appears.
     * The exact count is pino-pretty's business and would churn with its version.
     * If it ever stops attaching any, this goes red — and the answer then is to
     * guard the stream here, not to weaken the assertion.
     */
    'leaves the stdout guard to pino-pretty, which attaches its own', async () => {
      const before = process.stdout.listenerCount('error')

      await jest.isolateModulesAsync(async () => {
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        await dest.onInit()
        await dest.onShutdown()
      })

      expect(process.stdout.listenerCount('error')).toBeGreaterThan(before)
    })

    it(/*
     * When pino-pretty is not installed, onInit must throw an actionable error
     * (not a cryptic module-resolution failure) so the consumer knows to either
     * install the peer dep or drop this destination — it must NOT crash boot
     * silently.
     */
    'throws an actionable error when pino-pretty is missing', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('pino-pretty', () => {
          throw new Error("Cannot find module 'pino-pretty'")
        })
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        // Assert the FULL actionable message (both concatenated halves) so a
        // regression in either half is caught.
        await expect(new Fresh().onInit()).rejects.toThrow(
          /pino-pretty is not installed\. Install it as a peer dependency .* or remove PrettyDevDestination from/
        )
      })
      jest.dontMock('pino-pretty')
    })

    it(/*
     * onInit must configure pino-pretty with the exact documented options
     * (colorize, SYS time format, ignored base fields, multi-line, stdout sink).
     * Asserting the build() arguments pins each value so a regression in any one
     * is caught.
     */
    'configures pino-pretty with the documented options', async () => {
      await jest.isolateModulesAsync(async () => {
        const captured: Record<string, unknown>[] = []
        jest.doMock('pino-pretty', () => ({
          build: (opts: Record<string, unknown>) => {
            captured.push(opts)
            return { write: () => undefined, end: () => undefined, once: () => undefined }
          }
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        await new Fresh().onInit()
        expect(captured[0]).toMatchObject({
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
          destination: process.stdout
        })
      })
      jest.dontMock('pino-pretty')
    })

    it(/*
     * A consumer-chosen view must reach pino-pretty, overriding only the fields it
     * names — the terminal rendering is the whole point of the option, and a view
     * that silently kept the defaults would be another inert knob.
     */
    'passes the consumer view through, overriding only the named fields', async () => {
      await jest.isolateModulesAsync(async () => {
        const captured: Record<string, unknown>[] = []
        jest.doMock('pino-pretty', () => ({
          build: (opts: Record<string, unknown>) => {
            captured.push(opts)
            return { write: () => undefined, end: () => undefined, once: () => undefined }
          }
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        await new Fresh({
          view: { singleLine: true, hideObject: true, messageFormat: '[{context}] {msg}' }
        }).onInit()
        expect(captured[0]).toMatchObject({
          singleLine: true,
          hideObject: true,
          messageFormat: '[{context}] {msg}',
          // Untouched defaults survive alongside the overrides.
          colorize: true,
          ignore: 'pid,hostname,service'
        })
      })
      jest.dontMock('pino-pretty')
    })

    it(/*
     * REGRESSION — `destination` is applied AFTER the consumer's view, so it cannot
     * be overridden. `PrettyViewOptions` omits it, but omitting from a type is only
     * a suggestion: an untyped JavaScript caller can still pass it, and a redirected
     * stream would route around the multistream fan-out and the last-resort rescue.
     * Ordering the spread is what enforces the contract.
     */
    'ignores a destination smuggled in through the view', async () => {
      await jest.isolateModulesAsync(async () => {
        const captured: Record<string, unknown>[] = []
        jest.doMock('pino-pretty', () => ({
          build: (opts: Record<string, unknown>) => {
            captured.push(opts)
            return { write: () => undefined, end: () => undefined, once: () => undefined }
          }
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const hijack = { write: (): void => undefined }
        // Attached at RUNTIME rather than cast into the type. A cast would assert
        // something false to the compiler; this is what an untyped JavaScript
        // caller actually does — the property is simply there, and the type never
        // claimed otherwise.
        const view: PrettyViewOptions = {}
        Object.assign(view, { destination: hijack })

        await new Fresh({ view }).onInit()
        expect(captured[0]?.['destination']).toBe(process.stdout)
        expect(captured[0]?.['destination']).not.toBe(hijack)
      })
      jest.dontMock('pino-pretty')
    })
  })

  describe('write', () => {
    it(/*
     * After init, written entries must flow through the pino-pretty transform —
     * verified by asserting the stdout output is the prettified form (carries
     * the message but not the raw JSON envelope).
     */
    'forwards entries to the pretty transform once initialized', async () => {
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
      const dest = new PrettyDevDestination()
      await dest.onInit()

      dest.write(VALID_NDJSON_LINE)
      // onShutdown ends the transform, forcing pino-pretty to flush; the extra
      // delay covers the transform's async tick before assertion.
      await dest.onShutdown()
      await flushIo()

      const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(output).toContain('hello-pretty')
      expect(output).not.toContain('"msg":"hello-pretty"')
    })

    it(/*
     * Before onInit runs (e.g. every entry NestJS emits while instantiating
     * providers) write must not throw and must not lose the entry. It used to
     * print raw immediately; it now HOLDS the entry so the transform can render
     * it — see the `pre-init buffer` cases for where each held entry ends up.
     * What this case pins is the invariant that survived the change: write() is
     * safe before init, and nothing is emitted raw while rendering is still
     * possible.
     */
    'holds a pre-init write instead of printing it raw', () => {
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
      try {
        const dest = new PrettyDevDestination()

        expect(() => dest.write('raw-line\n')).not.toThrow()

        expect(stdoutSpy).not.toHaveBeenCalled()
      } finally {
        stdoutSpy.mockRestore()
      }
    })

    it(/*
     * After a FAILED init (pino-pretty absent) the destination is dropped from
     * the registry's active set, so its writes must be dropped too — NOT fall
     * back to stdout, which would silently duplicate raw NDJSON for every entry.
     */
    'drops writes after a failed init instead of duplicating to stdout', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('pino-pretty', () => {
          throw new Error("Cannot find module 'pino-pretty'")
        })
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        await expect(dest.onInit()).rejects.toThrow(/pino-pretty is not installed/)

        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
        dest.write('should-be-dropped\n')
        expect(stdoutSpy).not.toHaveBeenCalled()

        // Dropped is not the same as HELD, and "nothing on stdout" cannot tell
        // them apart — buffering is silent too. Shutting down drains anything
        // still held, so an entry that was merely buffered would surface here.
        // Before this assertion the pre-init buffer had quietly weakened this
        // case: flipping `initFailed` to false left the test passing, because a
        // write that took the buffer path produced exactly the same silence.
        // A cold mutation run is what exposed it.
        await dest.onShutdown()
        expect(stdoutSpy).not.toHaveBeenCalled()
      })
      jest.dontMock('pino-pretty')
    })
  })

  describe('onShutdown', () => {
    it(/*
     * After init, onShutdown must flush and close the transform, resolving only
     * once the stream has fully ended — graceful shutdown depends on this.
     */
    'flushes and resolves after init', async () => {
      jest.spyOn(process.stdout, 'write').mockReturnValue(true)
      const dest = new PrettyDevDestination()
      await dest.onInit()
      await expect(dest.onShutdown()).resolves.toBeUndefined()
    })

    it(/*
     * Calling onShutdown before init must be a safe no-op — a destination that
     * failed to initialize must still allow a clean application shutdown.
     */
    'is a no-op before init', async () => {
      const dest = new PrettyDevDestination()
      await expect(dest.onShutdown()).resolves.toBeUndefined()
    })

    it(/*
     * onShutdown must END the transform AND register an 'error' listener (so a
     * teardown error rejects cleanly rather than hanging / crashing). Asserting
     * the exact stream calls pins both behaviors.
     */
    'ends the stream and registers an error listener', async () => {
      await jest.isolateModulesAsync(async () => {
        const end = jest.fn((cb?: () => void) => cb?.())
        const once = jest.fn()
        jest.doMock('pino-pretty', () => ({
          build: () => ({ write: () => undefined, end, once })
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        await dest.onInit()

        await dest.onShutdown()

        expect(once).toHaveBeenCalledWith('error', expect.any(Function))
        expect(end).toHaveBeenCalled()
      })
      jest.dontMock('pino-pretty')
    })
  })

  describe('pre-init buffer', () => {
    let stdoutSpy: jest.SpyInstance

    beforeEach(() => {
      stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    })

    afterEach(() => {
      stdoutSpy.mockRestore()
      jest.dontMock('pino-pretty')
    })

    it(/*
     * The transform cannot exist before onInit — loading the optional peer is
     * async — so everything NestJS emits while instantiating providers arrives
     * first. Those entries used to go out as raw NDJSON: nothing lost, but a real
     * boot put dozens of JSON lines on screen before the first rendered one, and a
     * developer who had just enabled pretty concluded it had not worked. They are
     * now held and RENDERED, in arrival order.
     */
    'renders pre-init entries through the transform, in order', async () => {
      await jest.isolateModulesAsync(async () => {
        const rendered: string[] = []
        jest.doMock('pino-pretty', () => ({
          build: () => ({
            write: (line: string) => rendered.push(line),
            end: () => undefined,
            once: () => undefined
          })
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()

        dest.write('first\n')
        dest.write('second\n')
        // Held, not printed raw — that is the whole change.
        expect(stdoutSpy).not.toHaveBeenCalled()

        await dest.onInit()

        expect(rendered).toEqual(['first\n', 'second\n'])
      })
    })

    it(/*
     * REGRESSION — the buffer must never become a way to LOSE entries the old
     * raw-passthrough would have printed. When onInit fails the renderer never
     * arrives, so everything held goes out raw.
     */
    'flushes the buffer raw when init fails', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('pino-pretty', () => {
          throw new Error("Cannot find module 'pino-pretty'")
        })
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        dest.write('boot-entry\n')

        await expect(dest.onInit()).rejects.toThrow(/pino-pretty is not installed/)

        expect(stdoutSpy).toHaveBeenCalledWith('boot-entry\n')
      })
    })

    it(/*
     * Nothing guarantees onInit ever runs, so the buffer is bounded. On overflow
     * it drains what it holds BEFORE writing the entry that tripped it — draining
     * afterwards would replay old entries after newer ones, which reads as
     * corruption rather than as a fallback.
     */
    'drains in order and falls back to raw once the bound is reached', async () => {
      await jest.isolateModulesAsync(async () => {
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()

        for (let i = 0; i < 1001; i += 1) {
          dest.write(`entry-${i}\n`)
        }

        const written = stdoutSpy.mock.calls.map((call) => call[0] as string)
        expect(written).toHaveLength(1001)
        expect(written[0]).toBe('entry-0\n')
        expect(written[1000]).toBe('entry-1000\n')
        // Past the bound, entries go straight out rather than accumulating.
        dest.write('after\n')
        expect(stdoutSpy).toHaveBeenLastCalledWith('after\n')
      })
    })

    it(/*
     * REGRESSION — the entry COUNT does not bound memory. A payload has no
     * whole-record size limit (`maxEntrySizeBytes` bounds what a serializer emits
     * for one field, not the entry), so entries carrying large metadata could
     * retain far more than 1000 × "a log line" suggests — where the raw
     * passthrough this buffer replaced retained nothing at all. A buffer added
     * for legibility must not become a memory risk during boot.
     */
    'falls back to raw once the byte ceiling is reached, well before the count', () => {
      const dest = new PrettyDevDestination()
      // 512 KiB each: nine of these pass 4 MiB while the count is nowhere near
      // 1000, so only the byte ceiling can be what stops the buffering.
      const fat = 'x'.repeat(512 * 1024) + '\n'

      for (let i = 0; i < 9; i += 1) {
        dest.write(fat)
      }

      expect(stdoutSpy).toHaveBeenCalled()
      expect(stdoutSpy.mock.calls.length).toBeLessThan(1000)
    })

    it(/*
     * The ceiling is inclusive: an entry that lands EXACTLY on the limit is still
     * held. Pinning the boundary rather than a value comfortably inside it — the
     * comparison is the whole bound, and off-by-one there is the difference
     * between "holds 4 MiB" and "holds 4 MiB minus one entry".
     */
    'still holds an entry that lands exactly on the byte ceiling', () => {
      const dest = new PrettyDevDestination()
      // Exactly 4 MiB of single-byte characters, newline included.
      const exact = 'x'.repeat(4 * 1024 * 1024 - 1) + '\n'

      dest.write(exact)

      expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it(/*
     * Shutdown before onInit ever ran: the held entries were buffered for a
     * transform that will now never exist, so they go out raw rather than dying
     * with the process.
     */
    'flushes the buffer raw when shut down before init', async () => {
      await jest.isolateModulesAsync(async () => {
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        dest.write('never-rendered\n')

        await dest.onShutdown()

        expect(stdoutSpy).toHaveBeenCalledWith('never-rendered\n')
      })
    })

    it(/*
     * REGRESSION — a transform write that throws during the replay must not be
     * reported as a missing peer, and must not take the rest of the buffer with it.
     *
     * The replay used to sit inside the catch that reports `pino-pretty` as
     * missing, so a throwing write produced a diagnosis that was simply false —
     * sent to an operator who would go install a package that is already there.
     * Worse, `flushBuffer` detaches the whole buffer before emitting, so the
     * catch-path raw flush found nothing left: the entry that threw AND every
     * entry after it were lost. A buffer that loses a boot log is worse than no
     * buffer, since losing them is the thing it was added to prevent.
     */
    'degrades one failing replay write to raw and keeps replaying', async () => {
      await jest.isolateModulesAsync(async () => {
        const rendered: string[] = []
        jest.doMock('pino-pretty', () => ({
          build: () => ({
            write: (line: string) => {
              if (line === 'second\n') {
                throw new Error('transform write failed')
              }
              rendered.push(line)
            },
            end: () => undefined,
            once: () => undefined
          })
        }))
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        dest.write('first\n')
        dest.write('second\n')
        dest.write('third\n')

        // Not a missing peer, so onInit must not claim one — and must not reject.
        await expect(dest.onInit()).resolves.toBeUndefined()

        // The two that could render did; the one that threw fell back to raw.
        expect(rendered).toEqual(['first\n', 'third\n'])
        expect(stdoutSpy).toHaveBeenCalledWith('second\n')
      })
    })

    it(/*
     * A flush must EMPTY the buffer, so a second flush emits nothing. Both drain
     * paths can run for one destination — init fails and drains raw, then shutdown
     * finds no stream and drains again — and an entry emitted twice on a failure
     * path is a log that contradicts itself about how many times something
     * happened. Mutation testing found this: emptying was untested, because a
     * single flush cannot observe it.
     */
    'emits nothing on a second flush', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('pino-pretty', () => {
          throw new Error("Cannot find module 'pino-pretty'")
        })
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        dest.write('boot-entry\n')

        await expect(dest.onInit()).rejects.toThrow()
        expect(stdoutSpy).toHaveBeenCalledTimes(1)

        // Second drain path for the same destination.
        await dest.onShutdown()

        expect(stdoutSpy).toHaveBeenCalledTimes(1)
      })
    })

    it(/*
     * Writes to stdout can fail (EPIPE on a closed pipe, `node app | head`).
     * Salvaging a held entry must not become the crash it exists to prevent.
     */
    'survives a throwing stdout while draining', async () => {
      await jest.isolateModulesAsync(async () => {
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        const dest = new Fresh()
        dest.write('held\n')
        stdoutSpy.mockImplementation(() => {
          throw new Error('EPIPE')
        })

        await expect(dest.onShutdown()).resolves.toBeUndefined()
      })
    })
  })
})
