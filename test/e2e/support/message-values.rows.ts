/**
 * The rows for objects that reach the message of an entry through the Pino logger that
 * `getRawLogger()` returns, run once for each Pino the specs that call this load.
 *
 * Layer: e2e support, server (`BymaxLoggerModule`, the Pino factory, the redaction walk).
 */
import { Test } from '@nestjs/testing'
import pino from 'pino'
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

type Log = (...inputs: unknown[]) => void

/** The raw logger with the arguments Pino accepts at run time, which its types narrow by message. */
interface Raw {
  info: Log
  debug: Log
  audit: Log
  child(bindings: object, options?: object): Raw
}
type Line = Record<string, unknown>

/** A fresh bag with a name the default redaction covers beside one it does not. */
const bag = (): Record<string, unknown> => ({ password: SECRET, kept: 'visible' })

/** What the walk leaves of {@link bag}, as JSON. */
const CENSORED = '{"password":"[REDACTED]","kept":"visible"}'

/** The lines a real application writes while `emit` runs. */
async function linesOf(
  emit: (raw: Raw) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<Line[]> {
  const collector = new Collector()
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-message-values', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  }).compile()
  await app.init()
  collector.payloads.length = 0
  const raw: object = app.get(PinoLoggerService).getRawLogger()
  emit(raw as Raw)
  const written = collector.payloads.slice()
  await app.close()
  return written.map((line) => JSON.parse(line) as Line)
}

/** The message of the one line `emit` writes. */
async function messageOf(
  emit: (raw: Raw) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<unknown> {
  const lines = await linesOf(emit, extra)
  expect(lines).toHaveLength(1)
  return lines[0]?.['msg']
}

const PLACEHOLDERS: ReadonlyArray<readonly [string, (raw: Raw) => void, string]> = [
  ['%o', (raw) => raw.info('P %o', bag()), `P ${CENSORED}`],
  ['%O', (raw) => raw.info('P %O', bag()), `P ${CENSORED}`],
  ['%j', (raw) => raw.info('P %j', bag()), `P ${CENSORED}`],
  ['%o after a record', (raw) => raw.info({ a: 1 }, 'P %o', bag()), `P ${CENSORED}`],
  ['%o of an array', (raw) => raw.info('P %o', [[bag()]]), `P [[${CENSORED}]]`],
  ['%o of a toJSON', (raw) => raw.info('P %o', { toJSON: bag }), `P ${CENSORED}`],
  [
    '%o of an Error field',
    (raw) => raw.info('P %o', Object.assign(new Error('boom'), bag())),
    `P ${CENSORED}`
  ],
  [
    'a custom level',
    (raw) => raw.child({}, { customLevels: { audit: 35 } }).audit('P %o', bag()),
    `P ${CENSORED}`
  ],
  [
    'a grandchild',
    (raw) => raw.child({ a: 1 }).child({ b: 2 }).info('P %o', bag()),
    `P ${CENSORED}`
  ],
  [
    'a child with a msgPrefix',
    (raw) => raw.child({}, { msgPrefix: '> ' }).info('P %o', bag()),
    `> P ${CENSORED}`
  ]
]

class Named {
  readonly id = 7
  toString(): string {
    return `Named#${String(this.id)}`
  }
}

/** What 1.4.35 wrote for these, measured on its build. */
const UNCHANGED: ReadonlyArray<readonly [string, (raw: Raw) => void, unknown]> = [
  ['%s of a plain object', (raw) => raw.info('P %s', bag()), 'P [object Object]'],
  ['%s of a class with toString', (raw) => raw.info('P %s', new Named()), 'P Named#7'],
  ['%s of an array', (raw) => raw.info('P %s', [1, bag()]), 'P 1,[object Object]'],
  ['%s of an Error', (raw) => raw.info('P %s', new Error('boom')), 'P Error: boom'],
  ['%d of a Date', (raw) => raw.info('P %d', new Date(0)), 'P 0'],
  ['%o of an Error', (raw) => raw.info('P %o', new Error('boom')), 'P {}'],
  ['%o of a Date', (raw) => raw.info('P %o', new Date(0)), 'P "1970-01-01T00:00:00.000Z"'],
  ['%o of a number', (raw) => raw.info('P %o', 5), 'P 5'],
  ['an argument with no placeholder', (raw) => raw.info('P', bag()), 'P'],
  [
    'an object message under a msgPrefix',
    (raw) => raw.child({}, { msgPrefix: '> ' }).info({}, new Named()),
    '> Named#7'
  ]
]

const AS_MESSAGE: ReadonlyArray<readonly [string, (raw: Raw) => void]> = [
  ['info(record, object)', (raw) => raw.info({ a: 1 }, bag())],
  ['info(null, object)', (raw) => raw.info(null, bag())],
  ['info(undefined, object)', (raw) => raw.info(undefined, bag())],
  ['a child', (raw) => raw.child({ a: 1 }).info({}, bag())]
]

/** Declare the rows under `label`. */
export function describeMessageValues(label: string): void {
  describe(`Logger E2E — objects in the message (${label})`, () => {
    it.each(PLACEHOLDERS)('redacts %s', async (_name, emit, expected) => {
      expect(await messageOf(emit)).toBe(expected)
    })

    it.each(AS_MESSAGE)('redacts the object of %s', async (_name, emit) => {
      expect(await messageOf(emit)).toStrictEqual(JSON.parse(CENSORED))
    })

    it.each(UNCHANGED)('writes %s as before', async (_name, emit, expected) => {
      expect(await messageOf(emit)).toStrictEqual(expected)
    })

    it('does not read an object of a disabled level', async () => {
      let reads = 0
      const probe = {
        get password(): string {
          reads += 1
          return SECRET
        }
      }

      const lines = await linesOf(
        (raw) => {
          raw.debug('P %o', probe)
          raw.debug({}, probe)
        },
        { level: 'info' }
      )

      expect(lines).toHaveLength(0)
      expect(reads).toBe(0)
    })

    it.each(['%o', '%O', '%j'])('keeps the redact paths of Pino on %s', async (placeholder) => {
      const message = await messageOf(
        (raw) => raw.info(`P ${placeholder}`, { zzz: { yyy: SECRET }, ...bag() }),
        { redactPaths: ['zzz.yyy'] }
      )

      expect(message).toBe(
        'P {"zzz":{"yyy":"[REDACTED]"},"password":"[REDACTED]","kept":"visible"}'
      )
    })

    it('redacts the placeholders of a child with its own redact paths, and keeps them', async () => {
      const message = await messageOf((raw) =>
        raw
          .child({}, { redact: ['kept'] })
          .child({})
          .info('P %o', bag())
      )

      expect(message).toBe('P {"password":"[REDACTED]","kept":"[Redacted]"}')
    })

    it('refuses to start when Pino lacks a member the walk composes with', async () => {
      jest.replaceProperty(pino, 'symbols', {
        ...pino.symbols,
        writeSym: undefined
      } as unknown as typeof pino.symbols)

      await expect(linesOf(() => undefined)).rejects.toThrow('LOGGER_PINO_UNSUPPORTED')
    })

    it("does not walk the message under redactStrategy: 'paths'", async () => {
      // Below the depth Pino's default paths reach, so only the walk by name would censor it.
      const deep = { a: { b: { c: { d: { e: bag() } } } } }
      const lines = await linesOf(
        (raw) => {
          raw.info('P %o', deep)
          raw.info({}, deep)
        },
        { redactStrategy: 'paths' }
      )

      expect(lines.map((line) => line['msg'])).toStrictEqual([`P ${JSON.stringify(deep)}`, deep])
    })
  })
}
