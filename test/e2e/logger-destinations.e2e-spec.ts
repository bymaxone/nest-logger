import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

/**
 * End-to-end coverage for custom destinations and the destination-registry
 * resilience invariant: a failing destination MUST NOT crash the application.
 *
 * Note: write()-path failure isolation (a throwing `write` surfacing as a
 * per-stream error without taking down siblings) is covered at the unit level
 * (`destination-to-stream.spec.ts`); exercising it here would risk an unhandled
 * stream `error` event in the runner, so this suite covers the onInit-failure
 * path — the implemented resilience path that emits a meta-log.
 */

/** Custom sink that records every serialized NDJSON payload it receives. */
class CollectorDestination implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }

  /** Parse the collected payloads into log-entry objects. */
  entries(): Record<string, unknown>[] {
    return this.payloads.map((payload) => JSON.parse(payload) as Record<string, unknown>)
  }
}

/** Custom sink tracking whether its lifecycle hooks were invoked. */
class LifecycleDestination implements ILogDestination {
  readonly name = 'lifecycle'
  isInitCalled = false
  isShutdownCalled = false

  write(): void {
    // No-op: this sink only asserts lifecycle hook invocation.
  }

  async onInit(): Promise<void> {
    this.isInitCalled = true
  }

  async onShutdown(): Promise<void> {
    this.isShutdownCalled = true
  }
}

/** Custom sink whose onInit always rejects — to prove failure isolation. */
class FailingInitDestination implements ILogDestination {
  readonly name = 'failing-init'

  write(): void {
    // No-op: never reached for assertions; the failure is in onInit.
  }

  async onInit(): Promise<void> {
    throw new Error('init boom')
  }
}

describe('Logger E2E — custom destinations', () => {
  let app: INestApplication | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  /** Boot the module with the given overrides and return the app. */
  /**
   * Parse the NDJSON entries a stream spy captured, ignoring anything that is not
   * a JSON object.
   *
   * The app boots with `logger: false`, so today every byte on these streams is
   * ours. The guard is for tomorrow: an unrelated line would otherwise fail the
   * test with a `JSON.parse` error instead of the assertion that actually matters.
   */
  function parseNdjson(spy: jest.SpyInstance): Record<string, unknown>[] {
    return spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  async function bootApp(overrides: Partial<BymaxLoggerModuleOptions>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-dest', version: '0.0.0' },
          ...overrides
        })
      ]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    return app
  }

  it(/*
   * A consumer-supplied destination must receive the already-serialized NDJSON
   * payloads — the `destinations` option + `ILogDestination` contract working
   * end-to-end through the Pino multistream.
   */
  'routes serialized entries to a custom destination', async () => {
    const collector = new CollectorDestination()
    const booted = await bootApp({ destinations: [collector] })

    booted.get(PinoLoggerService, { strict: false }).info('DEST_PROBE', 'probe')

    const keys = collector.entries().map((entry) => entry['logKey'])
    expect(keys).toContain('DEST_PROBE')
    // The default stdout sink is REPLACED, so the bootstrap entry lands here too.
    expect(keys).toContain('LOGGER_BOOTSTRAP_OK')
  })

  it(/*
   * The registry must call `onInit` during bootstrap and `onShutdown` during
   * `app.close()` — the full destination lifecycle.
   */
  'invokes onInit on boot and onShutdown on close', async () => {
    const destination = new LifecycleDestination()
    const booted = await bootApp({ destinations: [destination] })

    expect(destination.isInitCalled).toBe(true)
    expect(destination.isShutdownCalled).toBe(false)

    await booted.close()
    app = undefined
    expect(destination.isShutdownCalled).toBe(true)
  })

  it(/*
   * REGRESSION — audit finding D-1. `LOGGER_SHUTDOWN_OK` was declared in the
   * reserved catalog and never written by any code path. It is the bookend to
   * `LOGGER_BOOTSTRAP_OK`: its absence in a log stream is how an operator tells
   * a graceful shutdown from a killed process. It must be emitted BEFORE the
   * sinks are torn down, which is why the collector still receives it.
   */
  'emits LOGGER_SHUTDOWN_OK before tearing the destinations down', async () => {
    const collector = new CollectorDestination()
    const booted = await bootApp({ destinations: [collector] })

    expect(collector.entries().map((entry) => entry['logKey'])).not.toContain('LOGGER_SHUTDOWN_OK')

    await booted.close()
    app = undefined

    const shutdown = collector.entries().find((entry) => entry['logKey'] === 'LOGGER_SHUTDOWN_OK')
    expect(shutdown).toBeDefined()
    expect(shutdown?.['destinations']).toBe(1)
  })

  it(/*
   * A destination whose `onInit` throws must NOT crash the app: boot succeeds, a
   * `LOGGER_DESTINATION_INIT_FAILED` report naming the offender reaches STDERR,
   * and the healthy destination keeps receiving subsequent logs.
   *
   * The report goes to stderr rather than through the logger because the sinks
   * that just failed may be the only ones the application has — see the
   * total-failure case below, which is what that choice exists for.
   */
  'isolates a destination that fails to initialize', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const collector = new CollectorDestination()
      const failing = new FailingInitDestination()
      const booted = await bootApp({ destinations: [collector, failing] })

      booted.get(PinoLoggerService, { strict: false }).info('AFTER_FAIL', 'still works')

      const reports = parseNdjson(stderrSpy).filter(
        (entry) => entry['logKey'] === 'LOGGER_DESTINATION_INIT_FAILED'
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]?.['destination']).toBe('failing-init')

      const entries = collector.entries()
      expect(entries.some((entry) => entry['logKey'] === 'AFTER_FAIL')).toBe(true)
      // The healthy sink must not receive the failure report — routing it back
      // through the logger is what created the feedback loop this replaced.
      expect(entries.some((e) => e['logKey'] === 'LOGGER_DESTINATION_INIT_FAILED')).toBe(false)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it(/*
   * REGRESSION — the defect that motivated the health record, end to end. Reported
   * by the community-core backend and reproduced here: `destinations` REPLACES the
   * default stdout sink, so a sole destination that fails `onInit` used to leave
   * the application booting, running, exiting 0 and writing NOTHING to either
   * stream — with the diagnostic explaining why delivered into the dead sink.
   *
   * Everything the run produces must now be accounted for: the entries fall back
   * to raw NDJSON on stdout (including the bootstrap announcement, whose
   * `LOGGER_BOOTSTRAP_WARNING` sibling exists so a security review can see that
   * PII redaction was disabled), and stderr names the cause.
   */
  'falls back to raw NDJSON on stdout when every destination fails to initialize', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const booted = await bootApp({ destinations: [new FailingInitDestination()] })

      booted.get(PinoLoggerService, { strict: false }).info('AFTER_TOTAL_FAIL', 'still works')

      const rescued = parseNdjson(stdoutSpy)
      expect(rescued.map((entry) => entry['logKey'])).toEqual(
        expect.arrayContaining(['LOGGER_BOOTSTRAP_OK', 'AFTER_TOTAL_FAIL'])
      )
      expect(stderrSpy.mock.calls.map((call) => call[0] as string).join('')).toContain(
        'LOGGER_DESTINATION_INIT_FAILED'
      )
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })
})
