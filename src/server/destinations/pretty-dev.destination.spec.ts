import { PrettyDevDestination } from './pretty-dev.destination'

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
     * Before onInit runs (e.g. a bootstrap log emitted while the registry is
     * still initializing destinations) write must fall back to raw stdout so the
     * entry is never lost and write() never throws.
     */
    'falls back to raw stdout before init', () => {
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
      const dest = new PrettyDevDestination()

      dest.write('raw-line\n')

      expect(stdoutSpy).toHaveBeenCalledWith('raw-line\n')
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
})
