/**
 * Verifies that the built-in methods the redaction and the routing decide with are the ones captured when
 * the logger was imported: a method replaced afterwards (`Set.prototype.has` that answers `undefined`, a
 * `toLowerCase` that does nothing, an `add` that adds nothing) changes neither what is hidden nor where a
 * log goes. Each replacement is made around a logger built and used inside it, and around one built
 * before it.
 *
 * Layer: server, tests. Driven through the real factory, in one process, with the method put back.
 */
import { resolveOptions } from './config/resolve-options'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const TOKENS = [
  'sEcReT1xyz',
  'sEcReT2xyz',
  'sEcReT3xyz',
  'sEcReT4xyz',
  'sEcReT5xyz',
  'sEcReT6xyz',
  'sEcReT7xyz',
  'sEcReT8xyz',
  'sEcReT9xyz'
]

interface Built {
  readonly logger: PinoLoggerService
  readonly lines: string[]
}

/** A logger and the lines it writes; `message` and `custom` are names to hide. */
function build(): Built {
  const lines: string[] = []
  const sink = { name: 'sink', write: (line: unknown) => void (lines[lines.length] = String(line)) }
  const options = resolveOptions({
    service: { name: 'app', version: '1.0.0' },
    redactPaths: ['custom', 'message', 'customKey']
  })
  const logger = new PinoLoggerService(
    buildPinoInstance(options, new LogContextService(), [sink as never], new DestinationHealth())
  )
  return { logger, lines }
}

/** A record with a secret under a default name, a configured name, a nested name, and in an error. */
function write(logger: PinoLoggerService): void {
  logger.warn({
    event: 'E',
    password: TOKENS[0],
    token: TOKENS[1],
    custom: TOKENS[2],
    meta: { apiKey: TOKENS[3], nested: { secret: TOKENS[4] } },
    // Spellings of the configured name `customKey`, which are folded to be compared: ASCII, then not.
    custom_key: TOKENS[6],
    'CUSTOM-KEY': TOKENS[7],
    'custom\u200bKey': TOKENS[8]
  } as never)
  logger.error(new Error(`${TOKENS[5] ?? ''} boom`), 'ctx')
}

/** What the logger writes while `holder[key]` is replaced by `replacement`, which answers nothing unless it is given. */
function writtenWith(
  holder: object,
  key: string | symbol,
  prebuilt: Built | undefined,
  replacement: (this: unknown, ...args: unknown[]) => unknown = () => undefined
): { lines: string[]; threw: boolean } {
  const original = Object.getOwnPropertyDescriptor(holder, key) as PropertyDescriptor
  Object.defineProperty(holder, key, { ...original, value: replacement })
  try {
    const built = prebuilt ?? build()
    write(built.logger)
    return { lines: built.lines, threw: false }
  } catch {
    return { lines: [], threw: true }
  } finally {
    Object.defineProperty(holder, key, original)
  }
}

/** The built-ins this library decides with, and the holder of each. */
const REPLACED: ReadonlyArray<readonly [string, object, string]> = [
  ['Set.prototype.has', Set.prototype, 'has'],
  ['Set.prototype.add', Set.prototype, 'add'],
  ['String.prototype.toLowerCase', String.prototype, 'toLowerCase'],
  ['String.prototype.replaceAll', String.prototype, 'replaceAll']
]

const identity = function (this: unknown): unknown {
  return String(this)
}
const yes = (): unknown => true
const none = (): unknown => null

/**
 * The built-ins the folding of a name decides with, each replaced by an identity, a constant true or no
 * match. The last item is whether a logger can also be built inside the replacement: Pino itself reads
 * `RegExp.prototype.exec` when it compiles the redaction paths, and the options are read through the
 * iterator of an array, so a logger built inside those two fails loudly, which writes nothing.
 */
const FOLDING: ReadonlyArray<
  readonly [
    string,
    object,
    string | symbol,
    (this: unknown, ...args: unknown[]) => unknown,
    boolean
  ]
> = [
  ['String.prototype.replace as the identity', String.prototype, 'replace', identity, true],
  ['String.prototype.normalize as the identity', String.prototype, 'normalize', identity, true],
  ['RegExp.prototype.test as true', RegExp.prototype, 'test', yes, true],
  ['RegExp.prototype.test as false', RegExp.prototype, 'test', () => false, true],
  ['RegExp.prototype.exec as no match', RegExp.prototype, 'exec', none, false],
  [
    'RegExp.prototype[Symbol.replace] as the identity',
    RegExp.prototype,
    Symbol.replace,
    identity,
    true
  ],
  [
    'Array.prototype[Symbol.iterator] as empty',
    Array.prototype,
    Symbol.iterator,
    function* () {},
    false
  ],
  [
    'Map.prototype[Symbol.iterator] as empty',
    Map.prototype,
    Symbol.iterator,
    function* () {},
    true
  ],
  ['Set.prototype[Symbol.iterator] as empty', Set.prototype, Symbol.iterator, function* () {}, true]
]

/** The built-ins the code that hides the message in an error stack reads, each replaced by one that leaves it whole. */
const STACK_BUILTINS: ReadonlyArray<
  readonly [string, object, string | symbol, (this: unknown, ...args: unknown[]) => unknown]
> = [
  ['String.prototype.slice as the identity', String.prototype, 'slice', identity],
  [
    'String.prototype[Symbol.iterator] as empty',
    String.prototype,
    Symbol.iterator,
    function* () {}
  ],
  ['Object.getOwnPropertyDescriptors as empty', Object, 'getOwnPropertyDescriptors', () => ({})],
  ['Reflect.ownKeys as empty', Reflect, 'ownKeys', () => []]
]

describe('a built-in replaced after the logger is imported', () => {
  const baseline = build()
  write(baseline.logger)

  /**
   * Given a built-in the redaction decides with, replaced by one that answers nothing
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then no secret is written, and the lines are the baseline's
   */
  it.each(REPLACED)('%s does not weaken what is hidden', (_name, holder, key) => {
    for (const prebuilt of [build(), undefined]) {
      const { lines, threw } = writtenWith(holder, key, prebuilt)

      expect(threw).toBe(false)
      expect(lines.join('\n')).not.toMatch(/sEcReT\d+xyz/)
      expect(lines).toHaveLength(baseline.lines.length)
    }
  })

  /**
   * Given a built-in Pino calls for each log call, or when it builds its fan-out, replaced by one that
   * answers nothing, which makes Pino write an `Error` unredacted or drop every log
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then no secret is written: the record is dropped, since a lost log is better than a secret in one
   */
  it.each([
    ['Array.prototype.shift', Array.prototype, 'shift'],
    ['Array.prototype.forEach', Array.prototype, 'forEach']
  ] as const)('%s is not trusted to Pino: the record is dropped', (_name, holder, key) => {
    for (const prebuilt of [build(), undefined]) {
      const { lines } = writtenWith(holder, key, prebuilt)

      expect(lines.join('\n')).not.toMatch(/sEcReT\d+xyz/)
      expect(lines).toHaveLength(0)
    }
  })

  /**
   * Given a built-in the folding of a name decides with, replaced by one that answers what a replacement
   * that does nothing answers (the text it was given), or `true`, or no match
   * When a logger built before it, and a logger built inside it, write the record of secrets, which
   * has the variant spellings of a configured name
   * Then no secret is written, and the lines are the baseline's
   */
  it.each(FOLDING)(
    '%s does not weaken what is hidden',
    (_name, holder, key, replacement, inside) => {
      for (const prebuilt of inside ? [build(), undefined] : [build()]) {
        const { lines, threw } = writtenWith(holder, key, prebuilt, replacement)

        expect(threw).toBe(false)
        expect(lines.join('\n')).not.toMatch(/sEcReT\d+xyz/)
        expect(lines).toHaveLength(baseline.lines.length)
      }
    }
  )

  /**
   * Given a built-in the code that hides the message in an error stack reads, replaced by one that
   * answers what a stack header needs to be left whole (the text, nothing, or no keys)
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then no secret is written: the record is dropped, or the logger is not built
   */
  it.each(STACK_BUILTINS)('%s leaves no message in a stack', (_name, holder, key, replacement) => {
    for (const prebuilt of [build(), undefined]) {
      const { lines } = writtenWith(holder, key, prebuilt, replacement)

      expect(lines.join('\n')).not.toMatch(/sEcReT\d+xyz/)
      expect(lines).toHaveLength(0)
    }
  })

  it('has secrets in the record to hide, which the baseline hides', () => {
    expect(baseline.lines.length).toBeGreaterThan(1)
    expect(baseline.lines.join('\n')).not.toMatch(/sEcReT\d+xyz/)
  })
})
