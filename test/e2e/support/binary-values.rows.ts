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

/** The lines a real application writes while each of `emits` runs. */
async function linesOf(
  emits: readonly Emit[],
  extra: Partial<BymaxLoggerModuleOptions>
): Promise<string[]> {
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
  const raw = app.get(PinoLoggerService).getRawLogger() as unknown as Raw
  for (const emit of emits) emit(raw)
  const written = collector.payloads.slice()
  await app.close()
  return written
}

/** The one line a real application writes while `emit` runs. */
async function lineOf(emit: Emit, extra: Partial<BymaxLoggerModuleOptions>): Promise<Line> {
  const written = await linesOf([emit], extra)
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

/** Eight bytes that were then transferred away, with the view made over them. */
function transferredUnder(make: (buffer: ArrayBuffer) => unknown): () => unknown {
  return () => {
    const buffer = new ArrayBuffer(8)
    const view = make(buffer)
    structuredClone(buffer, { transfer: [buffer] })
    return view
  }
}

/** Eight bytes that then shrank to none, with the view made over them. */
function shrunkUnder(make: (buffer: ArrayBuffer) => unknown): () => unknown {
  return () => {
    const buffer = Reflect.construct(ArrayBuffer, [8, { maxByteLength: 8 }]) as ArrayBuffer
    const view = make(buffer)
    ;(buffer as unknown as { resize(size: number): void }).resize(0)
    return view
  }
}

type ViewClass = new (buffer: ArrayBuffer, offset?: number, length?: number) => ArrayBufferView

const VIEW_CLASSES: readonly ViewClass[] = [
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
] as unknown as readonly ViewClass[]

/** Binary shapes, each with whether a line gives its size. */
const SHAPES: ReadonlyArray<readonly [string, () => unknown, string | undefined]> = [
  ...VIEW_CLASSES.flatMap((View) => {
    const whole = (buffer: ArrayBuffer): unknown =>
      new View(buffer, 0, 8 / ((View as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1))
    return [
      [`a transferred ${View.name}`, transferredUnder(whole), '[Binary 0 bytes]'],
      [`a shrunk ${View.name}`, shrunkUnder(whole), '[Binary 0 bytes]']
    ] as const
  }),
  ['a transferred Buffer', transferredUnder((b) => Buffer.from(b)), '[Binary 0 bytes]'],
  ['a shrunk Buffer', shrunkUnder((b) => Buffer.from(b, 0, 8)), '[Binary 0 bytes]'],
  ['a transferred ArrayBuffer', transferredUnder((b) => b), undefined],
  ['a SharedArrayBuffer', () => new SharedArrayBuffer(8), undefined],
  ['a DataView on shared memory', () => new DataView(new SharedArrayBuffer(8)), '[Binary 8 bytes]']
]

/** Every way in. `%s` and `%d` are Pino's own formatting, which the module does not reach. */
const ENTRIES: ReadonlyArray<(raw: Raw, value: unknown) => void> = [
  (raw, value) => raw.info(value),
  (raw, value) => raw.info(value, 'm'),
  (raw, value) => raw.info({ b: value }),
  (raw, value) => raw.info({}, value),
  (raw, value) => raw.info('%o', value),
  (raw, value) => raw.info('%O', value),
  (raw, value) => raw.info('%j', { b: value }),
  (raw, value) => raw.info({ err: Object.assign(new Error('e'), { stdout: value }) }, 'm'),
  (raw, value) => raw.child(value).info('c'),
  (raw, value) => raw.child({ b: value }).info('c'),
  (raw, value) => {
    const child = raw.child({})
    child.setBindings(value)
    child.info('c')
  },
  (raw, value) => {
    const child = raw.child({})
    child.setBindings({ b: value })
    child.info('c')
  }
]

/** A value that only its `toJSON` turns into what `make` gives. */
const behind = (make: () => unknown): object => ({ toJSON: make })

/** What a `toJSON` returns, with what the line holds in its place. */
const RETURNED: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ['a Buffer', bytes, MARKER],
  ['a typed array', () => new Uint16Array([90, 90]), '[Binary 4 bytes]'],
  ['a DataView', () => new DataView(new ArrayBuffer(3)), '[Binary 3 bytes]'],
  ['a nested Buffer', () => ({ b: bytes() }), MARKER]
]

/** An instance whose class has the `toJSON`. */
class Held {
  toJSON(): unknown {
    return bytes()
  }
}

/** Every way in that writes what a `toJSON` returns. */
const TO_JSON_ENTRIES: ReadonlyArray<readonly [string, (raw: Raw, value: object) => void]> = [
  ['%j', (raw, value) => raw.info('%j', value)],
  ['a member of %o', (raw, value) => raw.info('%o', { t: value })],
  ['%O', (raw, value) => raw.info('%O', [value])],
  ['an object message', (raw, value) => raw.info({}, value)],
  ['a member of the msg field', (raw, value) => raw.info({ msg: { t: value } })],
  ['a member of the merge object', (raw, value) => raw.info({ t: value }, 'm')],
  [
    'a field of the err',
    (raw, value) => raw.info({ err: Object.assign(new Error('e'), { t: value }) })
  ],
  ['a child binding', (raw, value) => raw.child({ t: value }).info('c')],
  [
    'setBindings',
    (raw, value) => {
      const child = raw.child({})
      child.setBindings({ t: value })
      child.info('c')
    }
  ]
]

/** Every way in, with an object whose getter or `toJSON` calls `read`. */
const READ_ONCE: ReadonlyArray<readonly [string, (raw: Raw, value: object) => void]> = [
  ...TO_JSON_ENTRIES,
  ['the merge object', (raw, value) => raw.info(value, 'm')],
  ['child bindings', (raw, value) => raw.child(value).info('c')],
  [
    'setBindings itself',
    (raw, value) => {
      const child = raw.child({})
      child.setBindings(value)
      child.info('c')
    }
  ]
]

/** Declares the rows for what a `toJSON` returns. */
function describeReturned(pinoName: string): void {
  describe.each(['names', 'paths'] as const)(
    `what the host's own code answers under '%s' (${pinoName})`,
    (redactStrategy) => {
      it.each(RETURNED)(
        'writes the size of %s that a toJSON returns',
        async (_name, make, size) => {
          const values = [behind(make), behind(() => behind(make))]
          const lines = await linesOf(
            values.flatMap((value) =>
              TO_JSON_ENTRIES.map(
                ([, entry]) =>
                  (raw: Raw) =>
                    entry(raw, value)
              )
            ),
            { redactStrategy }
          )

          expect(lines).toHaveLength(TO_JSON_ENTRIES.length * values.length)
          for (const line of lines) expect(line).toContain(size.replace(/"/g, ''))
        }
      )

      it('writes the size of what a toJSON of a class returns', async () => {
        const lines = await linesOf(
          TO_JSON_ENTRIES.map(
            ([, entry]) =>
              (raw: Raw) =>
                entry(raw, new Held())
          ),
          { redactStrategy }
        )

        for (const line of lines) expect(line).toContain(MARKER)
      })
    }
  )
}

/** Declares the rows for how often the host's code runs. */
function describeReads(pinoName: string): void {
  describe.each(['names', 'paths'] as const)(
    `the host's own code under '%s' (${pinoName})`,
    (redactStrategy) => {
      it.each(READ_ONCE)('reads a getter and a toJSON once through %s', async (_name, entry) => {
        let getter = 0
        let toJson = 0
        const value = {
          get a(): number {
            getter += 1
            return 1
          }
        }
        const other = {
          t: {
            toJSON(): number {
              toJson += 1
              return 1
            }
          }
        }

        await linesOf([(raw) => entry(raw, value), (raw) => entry(raw, other)], { redactStrategy })

        expect(getter).toBeLessThanOrEqual(1)
        expect(toJson).toBeLessThanOrEqual(1)
      })
    }
  )
}

/** Declares one row for each binary shape. */
function describeShapes(pinoName: string): void {
  describe.each(['names', 'paths'] as const)(
    `a binary shape through every way in under '%s' (${pinoName})`,
    (redactStrategy) => {
      it.each(SHAPES)('writes a line for %s', async (_name, make, size) => {
        const lines = await linesOf(
          ENTRIES.map((entry) => (raw: Raw) => entry(raw, make())),
          { redactStrategy }
        )

        expect(lines).toHaveLength(ENTRIES.length)
        for (const line of lines) {
          expect(line).not.toContain('LOGGER_REDACTION_FAILED')
          if (size !== undefined) expect(line).toContain(size)
        }
      })
    }
  )
}

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

  describeShapes(pinoName)

  describeReturned(pinoName)

  describeReads(pinoName)

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
