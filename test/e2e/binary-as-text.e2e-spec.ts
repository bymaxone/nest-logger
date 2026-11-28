/**
 * E2E: binary values given where the logger writes text: the message of a service call, the failure
 * report of a destination, and the stack of an error.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, the service, the registry, the error serializer).
 */
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

/** Six bytes. */
const CONTENT = 'AB-CDE'
const bytes = (): Buffer => Buffer.from(CONTENT)
const MARKER = '[Binary 6 bytes]'

/** An error given a binary value where it holds text, as code without types can do. */
const holding = (part: 'name' | 'message'): Error =>
  Object.assign(new Error('boom'), { [part]: bytes() }) as unknown as Error

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20))

/** What a destination throws or rejects with, and which of the two. */
interface Failure {
  value: () => unknown
  isAsync: boolean
}

/** A destination that fails while `armed` gives it something to fail with. */
function failingDestination(armed: () => Failure | undefined): ILogDestination {
  return {
    name: 'failing',
    write: (): void | Promise<void> => {
      const failure = armed()
      if (failure === undefined) return
      if (failure.isAsync) return Promise.reject(failure.value())
      throw failure.value()
    }
  }
}

/** The JSON lines among `text`. */
const parse = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/** The lines and the `stderr` text a real application writes while `emit` runs. */
async function written(
  emit: (logger: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions>,
  failure?: Failure
): Promise<{ lines: Record<string, unknown>[]; all: string; reports: Record<string, unknown>[] }> {
  const payloads: string[] = []
  let armed = false
  const collector: ILogDestination = {
    name: 'collector',
    write: (payload: string): void => {
      payloads.push(payload)
    }
  }
  const failing = failingDestination(() => (armed ? failure : undefined))
  const app = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-binary-as-text', version: '0.0.0' },
        destinations: failure === undefined ? [collector] : [collector, failing],
        ...extra
      })
    ]
  }).compile()
  await app.init()
  payloads.length = 0
  armed = true
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  emit(app.get(PinoLoggerService))
  await settle()
  armed = false
  const reported = stderr.mock.calls.map((call) => String(call[0])).join('')
  stderr.mockRestore()
  const lines = payloads.slice()
  await app.close()
  return {
    lines: parse(lines.join('')),
    all: lines.join('') + reported,
    reports: parse(reported)
  }
}

const clean = (all: string): void => {
  expect(all).not.toContain(CONTENT)
  expect(all).not.toContain('65,66,45')
}

describe.each(['names', 'paths'] as const)('binary values as text, %s', (redactStrategy) => {
  describe('the message of a service call', () => {
    it.each([
      ['log', bytes, MARKER],
      ['error', bytes, MARKER],
      ['warn', (): unknown => [bytes()], MARKER],
      ['fatal', (): unknown => new Uint8Array(bytes()), MARKER],
      ['log', (): unknown => holding('message'), MARKER]
    ] as const)('writes the size from %s', async (method, value, msg) => {
      const { lines, all } = await written((logger) => logger[method](value()), { redactStrategy })

      clean(all)
      expect(lines.map((line) => line['msg'])).toEqual([msg])
    })
  })

  describe('the failure report of a destination', () => {
    it.each([
      ['a buffer', bytes, { type: 'UnknownError', message: MARKER }],
      ['a list', (): unknown => [bytes()], { type: 'UnknownError', message: MARKER }],
      ['a message', (): unknown => holding('message'), { type: 'Error', message: MARKER }],
      ['a name', (): unknown => holding('name'), { type: MARKER, message: 'boom' }]
    ] as const)('writes the size of %s thrown or rejected', async (_label, value, err) => {
      for (const isAsync of [false, true]) {
        const { all, reports } = await written(
          (logger) => logger.log('ping'),
          { redactStrategy },
          { value, isAsync }
        )

        clean(all)
        expect(reports.map((report) => report['err'])).toEqual([err])
      }
    })
  })

  describe('the stack of an error', () => {
    it.each([
      ['a service error', 'name', (l: PinoLoggerService, e: Error): void => l.error(e)],
      [
        'a raw err',
        'name',
        (l: PinoLoggerService, e: Error): void => l.getRawLogger().error({ err: e })
      ],
      [
        'a cause',
        'name',
        (l: PinoLoggerService, e: Error): void => l.error(new Error('outer', { cause: e }))
      ],
      [
        'a metadata key',
        'name',
        (l: PinoLoggerService, e: Error): void => l.info('A_B_OK', 'x', undefined, { held: e })
      ],
      [
        'a service error with a binary message',
        'message',
        (l: PinoLoggerService, e: Error): void => l.errorStructured('A_B_FAILED', e)
      ],
      [
        'a metadata key with a binary message',
        'message',
        (l: PinoLoggerService, e: Error): void => l.info('A_B_OK', 'x', undefined, { held: e })
      ]
    ] as const)('holds no content under %s', async (_label, part, emit) => {
      const { lines, all } = await written((logger) => emit(logger, holding(part)), {
        redactStrategy
      })

      clean(all)
      expect(lines).toHaveLength(1)
    })
  })
})

describe.each(['names', 'paths'] as const)('a cause with a binary name, %s', (redactStrategy) => {
  it('is written with a text name and first stack line', async () => {
    const { lines } = await written(
      (logger) => logger.error(new Error('outer', { cause: holding('name') })),
      { redactStrategy }
    )
    const { cause } = lines[0]?.['err'] as { cause: { stack: string } }

    expect(cause.stack.split('\n')[0]).toBe('Error: boom')
  })
})

describe('with every redaction off', () => {
  it('holds no content in the stack of an error with a binary name', async () => {
    const { lines, all } = await written((logger) => logger.error(holding('name')), {
      redactStrategy: 'paths',
      redactPaths: [],
      shouldDisableDefaultRedact: true
    })

    clean(all)
    expect((lines[0]?.['err'] as { stack: string }).stack.split('\n')[0]).toBe('Error: boom')
  })
})

describe.each([
  ['names', {}],
  ['paths', { redactStrategy: 'paths' }],
  [
    'all redaction off',
    { redactStrategy: 'paths', redactPaths: [], shouldDisableDefaultRedact: true }
  ]
] as const)('a binary name that holds the text of the message, %s', (_label, extra) => {
  /** The bytes of the name repeat the message, in front of the content. */
  const nameRepeatsMessage = (): Error =>
    Object.assign(new Error('boom'), { name: Buffer.from(`boom-${CONTENT}`) }) as unknown as Error

  it.each([
    ['the error itself', nameRepeatsMessage],
    ['a cause', (): Error => new Error('outer', { cause: nameRepeatsMessage() })],
    ['an aggregate member', (): Error => new AggregateError([nameRepeatsMessage()], 'outer')]
  ] as const)('holds no content under %s', async (_position, error) => {
    const { lines, all } = await written((logger) => logger.error(error()), extra)

    clean(all)
    expect(lines).toHaveLength(1)
  })
})

describe('a value whose text never ends', () => {
  /** Each read of the message answers another error that does the same. */
  const endless = (): Error =>
    Object.defineProperty(new Error('x'), 'message', { get: endless }) as Error

  it.each([
    ['thrown by a destination', endless],
    [
      'a destination throws an error whose name and message both never end',
      (): Error => {
        const both = (): Error =>
          Object.defineProperties(new Error('x'), {
            name: { get: both },
            message: { get: both }
          }) as Error
        return both()
      }
    ],
    ['an array longer than any string', (): unknown => Object.assign([], { length: 2 ** 31 })]
  ] as const)('leaves the application running when %s', async (_label, value) => {
    const { lines, reports } = await written(
      (logger) => logger.log('ping'),
      {},
      { value, isAsync: false }
    )

    expect(lines.map((line) => line['msg'])).toEqual(['ping'])
    expect(reports).toHaveLength(1)
  })
})

describe.each(['names', 'paths'] as const)(
  'a pinned stack whose first line cannot be replaced, %s',
  (redactStrategy) => {
    /** The stack is a property of its own, holding the text of the name. */
    const pinned = (shape: 'value' | 'getter'): Error => {
      const name = bytes()
      name.toString = (): string => {
        throw new Error('no text')
      }
      const stack = `${CONTENT}: boom\n    at x (/a.js:1:1)`
      const error = Object.assign(new Error('boom'), { name: name as unknown as string })
      return Object.defineProperty(
        error,
        'stack',
        shape === 'value' ? { value: stack } : { get: () => stack }
      )
    }

    it.each([
      ['a value, as the error', 'value', (l: PinoLoggerService, e: Error): void => l.error(e)],
      ['a getter, as the error', 'getter', (l: PinoLoggerService, e: Error): void => l.error(e)],
      [
        'a value, under a metadata key',
        'value',
        (l: PinoLoggerService, e: Error): void => l.info('A_B_OK', 'x', undefined, { held: e })
      ],
      [
        'a value, as a raw err',
        'value',
        (l: PinoLoggerService, e: Error): void => l.getRawLogger().error({ err: e })
      ]
    ] as const)('holds no content when it is %s', async (_label, shape, emit) => {
      const { lines, all } = await written((logger) => emit(logger, pinned(shape)), {
        redactStrategy
      })

      clean(all)
      expect(lines).toHaveLength(1)
      expect(all).toContain('boom')
    })
  }
)
