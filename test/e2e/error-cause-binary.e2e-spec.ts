/**
 * E2E: binary values that the logger turns into the text of an error.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, the Pino factory, the error sanitizer).
 */
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { applyAccessLog, BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

/** Six bytes. */
const SECRET = 'ZZ-KEY'
const bytes = (): Buffer => Buffer.from(SECRET)
const MARKER = '[Binary 6 bytes]'

/** The node written for a value that is not an error. */
const unknownNode = (message: string): object => ({ name: 'UnknownError', message })

/** An error without a stack, so that a line holds only what the row gives. */
function bare<T extends Error>(error: T): T {
  delete error.stack
  return error
}

const caused = (cause: unknown): Error => bare(new Error('e', { cause }))

/** The `err` of the one line a real application writes while `emit` runs. */
async function errorOf(
  emit: (logger: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions>
): Promise<Record<string, unknown>> {
  const payloads: string[] = []
  const destination: ILogDestination = {
    name: 'collector',
    write: (payload: string): void => {
      payloads.push(payload)
    }
  }
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-error-cause-binary', version: '0.0.0' },
        destinations: [destination],
        ...extra
      })
    ]
  }).compile()
  await app.init()
  payloads.length = 0
  emit(app.get(PinoLoggerService))
  await new Promise((resolve) => setImmediate(resolve))
  const written = payloads.slice()
  await app.close()
  expect(written).toHaveLength(1)
  expect(written[0]).not.toContain(SECRET)
  expect(written[0]).not.toContain('90,90,45')
  return (JSON.parse(written[0] as string) as { err: Record<string, unknown> }).err
}

/** An error given a binary value where it holds text, as code without types can do. */
const holding = (part: 'name' | 'message'): Error =>
  bare(Object.assign(new Error(), { message: 5, [part]: bytes() }) as unknown as Error)

/** A typed array whose memory was transferred, so that none of its bytes can be read. */
const transferred = (): Uint8Array => {
  const view = new Uint8Array(6)
  structuredClone(view.buffer, { transfer: [view.buffer] })
  return view
}

/** Errors that hold a binary value, with what the `err` of the line must hold. */
const ROWS: ReadonlyArray<readonly [string, () => Error, object]> = [
  ['a Buffer as the cause', () => caused(bytes()), { cause: unknownNode(MARKER) }],
  [
    'a Uint8Array as the cause',
    () => caused(new Uint8Array(bytes())),
    { cause: unknownNode(MARKER) }
  ],
  [
    'a DataView as the cause',
    () => caused(new DataView(new ArrayBuffer(6))),
    { cause: unknownNode(MARKER) }
  ],
  [
    'a transferred typed array as the cause',
    () => caused(transferred()),
    { cause: unknownNode('[Binary 0 bytes]') }
  ],
  [
    'a Buffer two causes deep',
    () => caused(caused(bytes())),
    { cause: { name: 'Error', message: 'e', cause: unknownNode(MARKER) } }
  ],
  ['a Buffer in a cause array', () => caused([bytes()]), { cause: unknownNode(MARKER) }],
  [
    'a Buffer in an array inside a cause array',
    () => caused(['a', [bytes()], null]),
    { cause: unknownNode(`a,${MARKER},`) }
  ],
  [
    'a cause error whose message is a Buffer',
    () => caused(holding('message')),
    { cause: unknownNode(MARKER) }
  ],
  [
    'a cause error whose name is a Buffer',
    () => caused(holding('name')),
    { cause: unknownNode(MARKER) }
  ],
  [
    'a Buffer as an aggregate member',
    () => bare(new AggregateError([bytes()], 'e')),
    { errors: [unknownNode(MARKER)] }
  ],
  [
    'a Uint8Array in an array that is an aggregate member',
    () => bare(new AggregateError([[new Uint8Array(bytes())]], 'e')),
    { errors: [unknownNode(MARKER)] }
  ]
]

/** The entry points under test. */
const ENTRIES: ReadonlyArray<readonly [string, (logger: PinoLoggerService, e: Error) => void]> = [
  ['the raw logger', (logger, e) => logger.getRawLogger().info({ err: e }, 'm')],
  ['service.error', (logger, e) => logger.error('A_B_FAILED', e)]
]

const CONFIGURATIONS: ReadonlyArray<readonly [string, Partial<BymaxLoggerModuleOptions>]> = [
  ['names', { redactStrategy: 'names' }],
  ['paths', { redactStrategy: 'paths' }],
  ['redaction off', { shouldDisableDefaultRedact: true }]
]

describe.each(CONFIGURATIONS)('a binary error cause under %s', (_name, extra) => {
  describe.each(ENTRIES)('through %s', (_entry, log) => {
    it.each(ROWS)('writes %s as its size', async (_row, make, expected) => {
      expect(await errorOf((logger) => log(logger, make()), extra)).toMatchObject(expected)
    })
  })
})

describe('a cause that is not binary', () => {
  it.each([
    ['text', 'down', 'down'],
    ['an array', ['a', ['b', 'c'], null, undefined], 'a,b,c,,'],
    ['a plain object', { a: 1 }, '[object Object]'],
    ['an ArrayBuffer', new ArrayBuffer(6), '[object ArrayBuffer]']
  ])('keeps the text of %s', async (_name, cause, text) => {
    const err = await errorOf((logger) => logger.getRawLogger().info({ err: caused(cause) }), {})

    expect(err['cause']).toStrictEqual(unknownNode(text as string))
  })

  it('writes a line for an array that holds itself', async () => {
    const cycle: unknown[] = ['a', bytes()]
    cycle.push(cycle)

    const err = await errorOf((logger) => logger.getRawLogger().info({ err: caused(cycle) }), {})

    expect(err['cause']).toStrictEqual(unknownNode(`a,${MARKER},`))
  })
})

@Controller()
class Throwing {
  @Get('buffer')
  buffer(): never {
    throw bytes()
  }

  @Get('array')
  array(): never {
    throw [new Uint8Array(bytes())]
  }
}

/** The lines of one request to `path` of a listening application with the HTTP logging on. */
async function requestLines(path: string, withAccessLog: boolean): Promise<string[]> {
  const payloads: string[] = []
  const destination: ILogDestination = {
    name: 'collector',
    write: (payload: string): void => {
      payloads.push(payload)
    }
  }

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-thrown-binary', version: '0.0.0' },
        destinations: [destination],
        http: { isEnabled: true }
      })
    ],
    controllers: [Throwing]
  })
  class App {}

  const app = await NestFactory.create(App, { logger: false })
  if (withAccessLog) applyAccessLog(app)
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  payloads.length = 0
  await fetch(`${url}/${path}`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const written = payloads.slice()
  await app.close()
  return written
}

describe.each([
  ['the module alone', false],
  ['the access log applied', true]
])('a binary value thrown by a route, %s', (_name, withAccessLog) => {
  it.each(['buffer', 'array'])('writes its size on every line for /%s', async (path) => {
    const lines = await requestLines(path, withAccessLog)

    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('90,90,45')
    }
    expect(lines.filter((line) => line.includes(MARKER))).toHaveLength(2)
  })
})
