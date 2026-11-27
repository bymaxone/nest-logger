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
  ['child(bindings, { msgPrefix })', (raw) => raw.child(bag(), { msgPrefix: '> ' }).info('PROBE')],
  [
    'bindings that a getter gives',
    (raw) =>
      raw
        .child({
          held: {
            get password() {
              return SECRET
            }
          },
          kept: 'visible'
        })
        .info('PROBE')
  ],
  [
    'what bindings() of a child gives back to child',
    (raw) => {
      const parent = raw.child(bag())
      raw.child(parent.bindings()).info('PROBE %s', JSON.stringify(parent.bindings()))
    }
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

  const cyclic = (): Record<string, unknown> => {
    const value = bag()
    value['self'] = value
    return value
  }
  const deep = (): Record<string, unknown> => {
    let value = bag()
    for (let level = 0; level < 150; level++) value = { value }
    return value
  }

  it.each<[string, (raw: Raw) => void]>([
    [
      'the record of a child with its own redact',
      (raw) => raw.child(bag(), { redact: ['other'] }).info('PROBE')
    ],
    [
      'bindings of a child with a msgPrefix',
      (raw) => raw.child(bag(), { msgPrefix: '> ' }).info('PROBE')
    ],
    ['a cyclic binding', (raw) => raw.child({ held: cyclic() }).info('PROBE')],
    ['a deep binding', (raw) => raw.child({ held: deep() }).info('PROBE')],
    ['a binding with a toJSON', (raw) => raw.child({ held: { toJSON: bag } }).info('PROBE')],
    [
      'a binding behind a getter',
      (raw) =>
        raw
          .child({
            get held() {
              return bag()
            }
          })
          .info('PROBE')
    ],
    [
      'a cyclic and a deep binding of setBindings',
      (raw) => {
        const child = raw.child({})
        child.setBindings({ held: cyclic(), far: deep() })
        child.info('PROBE')
      }
    ],
    [
      'bindings() passed back to child()',
      (raw) => raw.child(raw.child(bag()).bindings()).info('PROBE')
    ],
    [
      'a child made inside the formatters.log of a child',
      (raw) => {
        const log = (record: object): object => {
          raw.child(bag()).info('PROBE')
          return record
        }
        raw.child({}, { formatters: { log } }).info('PROBE')
      }
    ]
  ])('redacts %s', async (_name, emit) => {
    const lines = await linesOf(emit)

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

  it.each([
    ['undefined', 'names'],
    ['null', 'names'],
    ['undefined', 'paths'],
    ['null', 'paths']
  ] as const)(
    'writes the line when a child formatters.log returns %s under %s',
    async (returned, redactStrategy) => {
      const nothing = returned === 'null' ? null : undefined
      const lines = await linesOf(
        (raw) =>
          raw.child({}, { formatters: { log: () => nothing as never } }).info({ a: 1 }, 'PROBE'),
        { redactStrategy }
      )

      expect(JSON.parse(lines)).toMatchObject({ msg: 'PROBE' })
    }
  )

  it("hands a child serializer your own objects under redactStrategy: 'paths'", async () => {
    const lines = await linesOf(
      (raw) =>
        raw
          .child({ at: new Date(0) }, { serializers: { at: (at: Date) => at.getTime() } })
          .info('PROBE'),
      { redactStrategy: 'paths' }
    )

    expect(JSON.parse(lines)).toMatchObject({ at: 0 })
  })

  it("hands a child formatters.bindings your own objects under redactStrategy: 'paths'", async () => {
    const at = new Date(0)
    const seen: unknown[] = []
    const keep = (bindings: Record<string, unknown>): Record<string, unknown> => {
      seen.push(bindings['at'])
      return bindings
    }
    await linesOf(
      (raw) => {
        const child = raw.child({ at }, { formatters: { bindings: keep } })
        child.setBindings({ at })
        child.info('PROBE')
      },
      { redactStrategy: 'paths' }
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(at)
    expect(seen[1]).toBe(at)
  })

  it('throws what Pino throws for a child with no bindings', async () => {
    await linesOf((raw) => {
      expect(() => raw.child(undefined as never)).toThrow('missing bindings for child Pino')
      raw.info('PROBE')
    })
  })
})

describe('Logger E2E — bindings of the raw logger at the limits of the walk', () => {
  /** `inner` below `levels` objects. */
  const nested = (levels: number, inner: unknown): unknown =>
    levels === 0 ? inner : { below: nested(levels - 1, inner) }

  it("redacts the bindings of a child given a redact option of its own under 'names'", async () => {
    const lines = await linesOf((raw) => raw.child(bag(), { redact: ['other'] }).info('PROBE'))

    expect(lines).toContain('visible')
    expect(lines).not.toContain(SECRET)
  })

  it("redacts what a toJSON in the bindings gives under 'names'", async () => {
    const lines = await linesOf((raw) => raw.child({ held: { toJSON: () => bag() } }).info('PROBE'))

    expect(lines).toContain('visible')
    expect(lines).not.toContain(SECRET)
  })

  it('cuts bindings nested past the depth of the walk', async () => {
    const lines = await linesOf((raw) => raw.child({ held: nested(150, bag()) }).info('PROBE'))

    expect(lines).toContain('[REDACTION_DEPTH_EXCEEDED]')
    expect(lines).not.toContain(SECRET)
  })

  it('writes cyclic bindings with the secret censored', async () => {
    const lines = await linesOf((raw) => {
      const held: Record<string, unknown> = bag()
      held['self'] = held
      raw.child({ held }).info('PROBE')
    })

    expect(lines).toContain('visible')
    expect(lines).not.toContain(SECRET)
  })

  it('writes no member past the budget of the walk', async () => {
    const lines = await linesOf((raw) => {
      const many = Array.from({ length: 200_001 }, () => ({}))
      raw.child({ many, last: bag() }).info('PROBE')
    })

    expect(lines).toContain('[REDACTION_BUDGET_EXCEEDED]')
    expect(lines).not.toContain(SECRET)
  })
})
