/**
 * E2E: redaction of what is passed to `child()` and `setBindings()` on the Pino logger that
 * `getRawLogger()` returns, through a real Nest application, one case for each way of passing it.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, the Pino factory, the redaction walk).
 */
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const SECRET = 'ZZ-SECRET'

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

type Raw = ReturnType<PinoLoggerService['getRawLogger']>

/** A fresh bag with a name the default redaction covers beside one it does not. */
const bag = (): Record<string, unknown> => ({ password: SECRET, kept: 'visible' })

/** The lines a real application writes while `emit` runs. */
async function linesOf(
  emit: (raw: Raw, service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<string> {
  const collector = new Collector()
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-raw-bindings', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  }).compile()
  await app.init()
  collector.payloads.length = 0
  const service = app.get(PinoLoggerService)
  emit(service.getRawLogger(), service)
  await app.close()
  return collector.payloads.filter((line) => line.includes('PROBE')).join('')
}

const CASES: ReadonlyArray<readonly [string, (raw: Raw, service: PinoLoggerService) => void]> = [
  ['child(bindings)', (raw) => raw.child(bag()).info('PROBE')],
  ['child(bindings, {})', (raw) => raw.child(bag(), {}).info('PROBE')],
  ['child(bindings, { level })', (raw) => raw.child(bag(), { level: 'debug' }).info('PROBE')],
  [
    'child(bindings, { formatters: {} })',
    (raw) => raw.child(bag(), { formatters: {} }).info('PROBE')
  ],
  ['a child of a raw child', (raw) => raw.child({ a: 1 }).child(bag()).info('PROBE')],
  [
    'a raw child of a service child',
    (_raw, service) => service.child({ a: 1 }).getRawLogger().child(bag()).info('PROBE')
  ],
  [
    'setBindings on a child',
    (raw) => {
      const child = raw.child({ a: 1 })
      child.setBindings(bag())
      child.info('PROBE')
    }
  ],
  [
    'child bindings with custom levels',
    (raw) => raw.child(bag(), { customLevels: { audit: 35 } }).audit('PROBE')
  ],
  [
    'a host formatters.bindings that returns its input',
    (raw) => raw.child(bag(), { formatters: { bindings: (b) => b } }).info('PROBE')
  ],
  [
    'a host formatters.bindings that adds a field',
    (raw) =>
      raw
        .child({ kept: 'visible' }, { formatters: { bindings: (b) => ({ ...b, ...bag() }) } })
        .info('PROBE')
  ],
  [
    'setBindings on a child with a host formatters.bindings',
    (raw) => {
      const child = raw.child({ a: 1 }, { formatters: { bindings: (b) => ({ ...b, ...bag() }) } })
      child.setBindings({ b: 2 })
      child.info('PROBE')
    }
  ],
  [
    'the record of a child with a host formatters.log',
    (raw) => raw.child({}, { formatters: { log: (o) => o } }).info(bag(), 'PROBE')
  ],
  [
    'the record of a grandchild below a host formatters.log',
    (raw) =>
      raw
        .child({}, { formatters: { log: (o) => o } })
        .child({})
        .info(bag(), 'PROBE')
  ],
  [
    'a field a host formatters.log adds',
    (raw) =>
      raw.child({}, { formatters: { log: (o) => ({ ...o, ...bag() }) } }).info({ a: 1 }, 'PROBE')
  ],
  [
    'a field a child serializer adds',
    (raw) =>
      raw.child({}, { serializers: { account: () => bag() } }).info({ account: 'a1' }, 'PROBE')
  ],
  [
    'a field a child formatters.level adds',
    (raw) =>
      raw
        .child(
          {},
          {
            customLevels: { audit: 35 },
            formatters: { level: (label) => ({ level: label, ...bag() }) }
          }
        )
        .info('PROBE')
  ],
  [
    'err bindings under a child err serializer',
    (raw) =>
      raw
        .child(
          { err: Object.assign(new Error('boom'), bag()) },
          { serializers: { err: (e: object) => ({ ...e }) } }
        )
        .info('PROBE')
  ]
]

describe('Logger E2E — bindings of the raw logger', () => {
  it.each(CASES)('redacts %s', async (_name, emit) => {
    const lines = await linesOf(emit)

    expect(lines).toContain('PROBE')
    expect(lines).not.toContain(SECRET)
  })

  it.each(CASES)("redacts %s under redactStrategy: 'paths'", async (_name, emit) => {
    const lines = await linesOf(emit, { redactStrategy: 'paths' })

    expect(lines).toContain('PROBE')
    expect(lines).not.toContain(SECRET)
  })

  it('censors a configured name in bindings and keeps the other fields', async () => {
    const lines = await linesOf(
      (raw) => raw.child({ ssn: SECRET, kept: 'visible' }).info('PROBE'),
      {
        redactPaths: ['ssn']
      }
    )

    expect(JSON.parse(lines)).toMatchObject({ ssn: '[REDACTED]', kept: 'visible' })
  })

  it('still runs the formatters and serializers of the child options', async () => {
    const lines = await linesOf((raw) =>
      raw
        .child(
          { a: 1 },
          {
            formatters: {
              bindings: (b) => ({ ...b, bound: true }),
              log: (o) => ({ ...o, logged: true })
            },
            serializers: { account: (id: string) => `account:${id}` }
          }
        )
        .info({ account: 'a1' }, 'PROBE')
    )

    expect(JSON.parse(lines)).toMatchObject({
      a: 1,
      bound: true,
      logged: true,
      account: 'account:a1'
    })
  })

  it('throws what Pino throws for a child with no bindings', async () => {
    await linesOf((raw) => {
      expect(() => raw.child(undefined as never)).toThrow('missing bindings for child Pino')
      raw.info('PROBE')
    })
  })
})
