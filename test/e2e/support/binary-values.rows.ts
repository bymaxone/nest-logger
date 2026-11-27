/**
 * The rows for binary values that reach a line through the Pino logger that `getRawLogger()`
 * returns, run once for each Pino the specs that call this load.
 *
 * Layer: e2e support, server (`BymaxLoggerModule`, the Pino factory, the redaction walk).
 */
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

type Log = (...inputs: unknown[]) => void

/** The raw logger with the arguments Pino accepts at run time, which its types narrow. */
interface Raw {
  info: Log
  child(bindings: unknown, options?: object): Raw
  setBindings(bindings: unknown): void
}
type Line = Record<string, unknown>
type Emit = (raw: Raw) => void

/** Six bytes. */
const bytes = (): Buffer => Buffer.from('ZZ-KEY')
const MARKER = '[Binary 6 bytes]'

/** A DataView whose buffer was transferred, so that none of its bytes can be read. */
const transferred = (): DataView => {
  const buffer = new ArrayBuffer(6)
  const view = new DataView(buffer)
  structuredClone(buffer, { transfer: [buffer] })
  return view
}

/** The one line a real application writes while `emit` runs. */
async function lineOf(emit: Emit, extra: Partial<BymaxLoggerModuleOptions>): Promise<Line> {
  const collector = new Collector()
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-binary-values', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  }).compile()
  await app.init()
  collector.payloads.length = 0
  emit(app.get(PinoLoggerService).getRawLogger() as unknown as Raw)
  const written = collector.payloads.slice()
  await app.close()
  expect(written).toHaveLength(1)
  return JSON.parse(written[0] as string) as Line
}

/** The fields of a line that the call under test decides. */
function decided(line: Line): Line {
  const { level, time, service, deployment, ...rest } = line
  return rest
}

/** Calls that put a binary value in the message or in a binding. */
const NESTED: ReadonlyArray<readonly [string, Emit, Line]> = [
  ['a Buffer as the message', (raw) => raw.info({}, bytes()), { msg: MARKER }],
  [
    'an object message with a Buffer',
    (raw) => raw.info({}, { b: bytes() }),
    { msg: { b: MARKER } }
  ],
  ['a Buffer in %o', (raw) => raw.info('%o', bytes()), { msg: `"${MARKER}"` }],
  ['a Buffer in %j', (raw) => raw.info('%j', bytes()), { msg: `"${MARKER}"` }],
  ['a member of %o', (raw) => raw.info('%o', { b: bytes() }), { msg: `{"b":"${MARKER}"}` }],
  ['a child binding member', (raw) => raw.child({ b: bytes() }).info('c'), { b: MARKER, msg: 'c' }],
  [
    'a setBindings member',
    (raw) => {
      const child = raw.child({})
      child.setBindings({ b: bytes() })
      child.info('c')
    },
    { b: MARKER, msg: 'c' }
  ],
  [
    'a falsy msg serializer of a child',
    (raw) => raw.child({}, { serializers: { msg: undefined } }).info({}, bytes()),
    { msg: MARKER }
  ],
  [
    'a child with redact paths of its own',
    (raw) => raw.child({}, { redact: ['x.*'] }).info('%o', { b: bytes() }),
    { msg: `{"b":"${MARKER}"}` }
  ]
]

/** Calls that give a binary value where the fields of a line or of the bindings are expected. */
const ROOTS: ReadonlyArray<readonly [string, Emit, Line]> = [
  ['a Buffer as the merge object', (raw) => raw.info(bytes()), { binary: MARKER }],
  [
    'a Buffer as the merge object with a message',
    (raw) => raw.info(bytes(), 'm'),
    { binary: MARKER, msg: 'm' }
  ],
  [
    'a typed array as the merge object',
    (raw) => raw.info(new Uint8Array(bytes())),
    { binary: MARKER }
  ],
  [
    'a Buffer as the bindings of a child',
    (raw) => raw.child(bytes()).info('c'),
    { binary: MARKER, msg: 'c' }
  ],
  [
    'a Buffer given to setBindings',
    (raw) => {
      const child = raw.child({})
      child.setBindings(bytes())
      child.info('c')
    },
    { binary: MARKER, msg: 'c' }
  ],
  [
    'a Buffer from the bindings formatter of a child',
    (raw) => raw.child({ a: 1 }, { formatters: { bindings: () => bytes() } }).info('c'),
    { binary: MARKER, msg: 'c' }
  ],
  [
    'a transferred DataView as the bindings of a child',
    (raw) => raw.child(transferred()).info('c'),
    { binary: '[Binary 0 bytes]', msg: 'c' }
  ],
  [
    'a transferred DataView given to setBindings',
    (raw) => {
      const child = raw.child({})
      child.setBindings(transferred())
      child.info('c')
    },
    { binary: '[Binary 0 bytes]', msg: 'c' }
  ]
]

/** An object whose one getter makes another like it on every read. */
const endless = (): object => ({
  get next(): object {
    return endless()
  }
})

/** Calls that give the logger an object that never ends. */
const ENDLESS: ReadonlyArray<readonly [string, Emit]> = [
  ['%o', (raw) => raw.info('%o', endless())],
  ['an object message', (raw) => raw.info({}, endless())],
  ['a child binding', (raw) => raw.child({ x: endless() }).info('c')],
  [
    'setBindings',
    (raw) => {
      const child = raw.child({})
      child.setBindings({ x: endless() })
      child.info('c')
    }
  ]
]

/**
 * Declares the rows for the Pino that is loaded.
 *
 * @param pinoName - How the title names that Pino.
 */
export function describeBinaryValues(pinoName: string): void {
  describe.each(['names', 'paths'] as const)(
    `binary values under '%s' (${pinoName})`,
    (redactStrategy) => {
      it.each([...NESTED, ...ROOTS])('writes %s as its size', async (_name, emit, expected) => {
        expect(decided(await lineOf(emit, { redactStrategy }))).toStrictEqual(expected)
      })
    }
  )

  describe.each(['names', 'paths'] as const)(
    `an object that never ends under '%s' (${pinoName})`,
    (redactStrategy) => {
      it.each(ENDLESS)('writes one line through %s', async (_name, emit) => {
        expect(await lineOf(emit, { redactStrategy })).toHaveProperty('level')
      })
    }
  )

  describe(`binary values and a wildcard path of the host (${pinoName})`, () => {
    const hostPaths: Partial<BymaxLoggerModuleOptions> = {
      redactStrategy: 'paths',
      shouldDisableDefaultRedact: true,
      redactPaths: ['data.*']
    }

    it.each<readonly [string, Emit, Line]>([
      ['%o', (raw) => raw.info('%o', { data: bytes() }), { msg: `{"data":"${MARKER}"}` }],
      ['a child', (raw) => raw.child({ data: bytes() }).info('c'), { data: MARKER, msg: 'c' }]
    ])('writes the size through %s', async (_name, emit, expected) => {
      expect(decided(await lineOf(emit, hostPaths))).toStrictEqual(expected)
    })
  })
}
