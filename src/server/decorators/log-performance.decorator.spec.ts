import pino from 'pino'

import { LogPerformance } from './log-performance.decorator'
import { PinoLoggerService } from '../services/pino-logger.service'

/** Resolve after `ms` milliseconds — used to push a method past the threshold. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Fixture exercising the decorator across fast, slow, throwing, and no-logger paths. */
class ReportService {
  constructor(readonly logger?: PinoLoggerService) {}

  @LogPerformance(5)
  async slow(): Promise<string> {
    await delay(25)
    return 'slow-result'
  }

  @LogPerformance(100_000)
  async fast(): Promise<string> {
    return 'fast-result'
  }

  @LogPerformance(5)
  async boom(): Promise<never> {
    await delay(25)
    throw new Error('kaboom')
  }

  @LogPerformance()
  async defaultThreshold(): Promise<string> {
    return 'default-result'
  }
}

describe('LogPerformance', () => {
  let logger: PinoLoggerService
  let warnSpy: jest.SpyInstance
  let infoSpy: jest.SpyInstance

  beforeEach(() => {
    // A real but silent Pino logger lets us spy on the structured methods
    // without an unsafe mock cast (mirrors PinoLoggerService's own spec).
    logger = new PinoLoggerService(pino({ enabled: false }))
    warnSpy = jest.spyOn(logger, 'warnStructured')
    infoSpy = jest.spyOn(logger, 'info')
  })

  it(/*
   * A method exceeding the threshold must emit METHOD_SLOW_EXECUTION at warn
   * level with the qualified method name and timing metadata — the core
   * slow-path signal operators alert on.
   */
  'logs METHOD_SLOW_EXECUTION when the method exceeds the threshold', async () => {
    await new ReportService(logger).slow()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).not.toHaveBeenCalled()
    const [logKey, , userId, metadata] = warnSpy.mock.calls[0]
    expect(logKey).toBe('METHOD_SLOW_EXECUTION')
    expect(userId).toBeUndefined()
    expect(metadata).toMatchObject({ method: 'ReportService.slow', thresholdMs: 5 })
    expect(metadata.duration).toBeGreaterThan(5)
  })

  it(/*
   * A method under the threshold must emit METHOD_EXECUTION at info level —
   * covers the fast branch and confirms it does not warn.
   */
  'logs METHOD_EXECUTION when the method is under the threshold', async () => {
    await new ReportService(logger).fast()

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    const [logKey, , , metadata] = infoSpy.mock.calls[0]
    expect(logKey).toBe('METHOD_EXECUTION')
    expect(metadata).toMatchObject({ method: 'ReportService.fast' })
  })

  it(/*
   * The decorator must forward the original return value unchanged — wrapping
   * for timing must be transparent to callers.
   */
  'preserves the return value', async () => {
    expect(await new ReportService(logger).fast()).toBe('fast-result')
    expect(await new ReportService(logger).slow()).toBe('slow-result')
  })

  it(/*
   * Exceptions must propagate (never be swallowed) AND the timing log must still
   * fire from the finally block — observability must not mask failures.
   */
  'propagates exceptions while still logging timing', async () => {
    await expect(new ReportService(logger).boom()).rejects.toThrow('kaboom')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('METHOD_SLOW_EXECUTION')
  })

  it(/*
   * Called with no argument the decorator must fall back to the default
   * threshold (1000ms) — covers the default-parameter branch. A trivially fast
   * method therefore logs METHOD_EXECUTION, not a slow warning.
   */
  'defaults the threshold when called without an argument', async () => {
    await new ReportService(logger).defaultThreshold()

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy.mock.calls[0][0]).toBe('METHOD_EXECUTION')
  })

  it(/*
   * With no logger on the host the decorator must stay silent and still return
   * the value — covers the `if (this.logger)` false branch (fail-safe design).
   */
  'stays silent when the host has no logger', async () => {
    const bare = new ReportService()
    await expect(bare.fast()).resolves.toBe('fast-result')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it(/*
   * A throwing logger must NOT mask the method result — the timing log is
   * crash-safe. Covers the catch guard around the finally-block logging.
   */
  'swallows a logger failure instead of masking the method result', async () => {
    infoSpy.mockImplementation(() => {
      throw new Error('log sink down')
    })
    await expect(new ReportService(logger).fast()).resolves.toBe('fast-result')
  })
})
