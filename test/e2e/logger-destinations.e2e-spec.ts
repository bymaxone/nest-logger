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
   * A destination whose `onInit` throws must NOT crash the app: boot succeeds, a
   * `LOGGER_DESTINATION_INIT_FAILED` meta-log naming the offender is emitted, and
   * the healthy destination keeps receiving subsequent logs.
   */
  'isolates a destination that fails to initialize', async () => {
    const collector = new CollectorDestination()
    const failing = new FailingInitDestination()
    // Collector first so it initializes and remains active to capture the meta-log.
    const booted = await bootApp({ destinations: [collector, failing] })

    booted.get(PinoLoggerService, { strict: false }).info('AFTER_FAIL', 'still works')

    const entries = collector.entries()
    const metaLog = entries.find((entry) => entry['logKey'] === 'LOGGER_DESTINATION_INIT_FAILED')
    expect(metaLog).toBeDefined()
    expect(metaLog?.['destination']).toBe('failing-init')
    expect(entries.some((entry) => entry['logKey'] === 'AFTER_FAIL')).toBe(true)
  })
})
