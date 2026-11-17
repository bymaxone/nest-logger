/**
 * Verifies that no option refusal echoes the value it refused: it names the option and the TYPE of
 * what it received ("Received a string"), prints a finite number, and prints nothing else. The
 * options come from the resolved defaults, so an option added later is covered without an edit,
 * and each one is given a sentinel string, a Symbol, a function, an object and an array.
 *
 * Layer: server/config, tests. A value a caller hands over can be a secret read from a config file
 * (a token typed into the wrong field), and a message that quotes it puts that secret in a log.
 */
import { applyDefaults } from './default-options'
import { validateOptions } from './validate-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

const SENTINEL = 'SENTINEL-do-not-echo-9d41'

const VALID: BymaxLoggerModuleOptions = { service: { name: 'app', version: '1.0.0' } }

/** What each kind of value is called in a refusal, and the value that stands for it. */
const KINDS: ReadonlyArray<readonly [string, string, () => unknown]> = [
  ['a string', 'a string', () => SENTINEL],
  ['a symbol', 'a symbol', () => Symbol(SENTINEL)],
  [
    'a function',
    'a function',
    () =>
      function sentinelFunction() {
        return SENTINEL
      }
  ],
  ['an object', 'an object', () => ({ secret: SENTINEL })],
  ['an array', 'an array', () => [SENTINEL]]
]

/** The option paths of the resolved defaults, one level into the groups, `destinations` included. */
function optionPaths(): string[] {
  const resolved = applyDefaults(VALID) as unknown as Record<string, unknown>
  const paths: string[] = []
  for (const [key, value] of Object.entries(resolved)) {
    paths.push(key)
    const isGroup =
      typeof value === 'object' && value !== null && !Array.isArray(value) && key !== 'serializers'
    if (isGroup) for (const inner of Object.keys(value)) paths.push(`${key}.${inner}`)
  }
  return paths
}

/** The options with `path` set to `value`, bypassing the compile-time types. */
function withValue(path: string, value: unknown): BymaxLoggerModuleOptions {
  const copy = structuredClone(VALID) as unknown as Record<string, unknown>
  const resolved = applyDefaults(VALID) as unknown as Record<string, unknown>
  const [head, tail] = path.split('.') as [string, string | undefined]
  if (tail === undefined) {
    copy[head] = value
  } else {
    const group = { ...((copy[head] ?? resolved[head]) as Record<string, unknown>) }
    group[tail] = value
    copy[head] = group
  }
  return copy as unknown as BymaxLoggerModuleOptions
}

/** The message `validateOptions` throws for `options`, or `undefined` when it accepts them. */
function refusalOf(options: BymaxLoggerModuleOptions): string | undefined {
  try {
    validateOptions(options)
  } catch (error) {
    return (error as Error).message
  }
  return undefined
}

/**
 * Options the validator does not check, and why. `shouldUseAsNestLogger` is deprecated and the
 * module never reads it, so a wrong value changes nothing and refusing it would break a
 * configuration that works; every other option refuses at least one kind of value.
 */
const NOT_VALIDATED: ReadonlySet<string> = new Set(['shouldUseAsNestLogger'])

const PATHS = optionPaths()

describe('validateOptions: a refusal never echoes the value', () => {
  it('covers the options of the resolved defaults', () => {
    expect(PATHS).toEqual(expect.arrayContaining(['level', 'service.name', 'http.isEnabled']))
    expect(PATHS.length).toBeGreaterThan(30)
  })

  describe.each(PATHS)('options.%s', (path) => {
    it.each(KINDS)(
      'names the option and the type, and echoes nothing, for %s',
      (_label, typeName, make) => {
        const message = refusalOf(withValue(path, make()))

        // A kind the option accepts has nothing to refuse; the cases below show every option
        // refuses at least one of the kinds.
        if (message === undefined) return
        expect(message).not.toContain(SENTINEL)
        expect(message).toContain(`options.${path}`)
        // The option itself refused names the type it received. A group or a list refuses the
        // member that is wrong and names that one, with its own type or, when it is missing, none;
        // `serializers` does it on the option's own path, with the type of the member.
        if (message.includes(`options.${path} `)) {
          const received =
            path === 'serializers' && typeName === 'an object' ? 'a string' : typeName
          expect(message).toContain(`Received ${received}`)
        } else {
          expect(message).toMatch(new RegExp(`options\\.${path.replace('.', '\\.')}[.[]`))
        }
      }
    )

    it('refuses at least one of the kinds, unless it is a documented exception', () => {
      const refused = KINDS.filter(([, , make]) => refusalOf(withValue(path, make())) !== undefined)

      expect(refused.length > 0).toBe(!NOT_VALIDATED.has(path))
    })
  })

  describe('numbers and the other values', () => {
    it.each([
      ['a finite number', 3.5, 'the number 3.5'],
      ['NaN', Number.NaN, 'a number that is not finite'],
      ['Infinity', Number.POSITIVE_INFINITY, 'a number that is not finite'],
      ['a boolean', true, 'a boolean'],
      ['a bigint', 10n, 'a bigint']
    ])('describes %s as %s', (_label, value, expected) => {
      expect(refusalOf(withValue('level', value))).toContain(`Received ${expected}`)
    })

    /*
     * A `null` option is read as not set, so `null` is described where it is still refused: a
     * member of a list.
     */
    it('describes a null member of a list as null', () => {
      expect(refusalOf(withValue('redactPaths', [null]))).toBe(
        '[BymaxLoggerModule] options.redactPaths[0] must be a non-empty string. Received null'
      )
    })
  })
})

describe('validateOptions: the type of a list member that is undefined', () => {
  /*
   * A member of a list is always present, so a member that is `undefined` is a value that was
   * refused, and the refusal names its type like any other. A MEMBER of a destination that is
   * missing is not a value, so it keeps no clause.
   */
  it.each([
    [
      'redactPaths',
      { redactPaths: [undefined] },
      'options.redactPaths[0] must be a non-empty string. Received undefined'
    ],
    [
      'errorOwnFieldNames',
      { errorOwnFieldNames: [undefined] },
      'options.errorOwnFieldNames[0] must be a non-empty string. Received undefined'
    ],
    [
      'destinations',
      { destinations: [undefined] },
      'options.destinations[0] must be an object implementing ILogDestination. Received undefined'
    ],
    [
      'http.excludePaths',
      { http: { excludePaths: [undefined] } },
      'options.http.excludePaths[0] must be a RegExp. Received undefined'
    ],
    [
      'http.secretPathSegments',
      { http: { secretPathSegments: [undefined] } },
      'options.http.secretPathSegments[0] must be a RegExp. Received undefined'
    ]
  ])('names the type of an undefined member of %s', (_label, extra, message) => {
    const options = { ...VALID, ...extra } as unknown as BymaxLoggerModuleOptions

    expect(refusalOf(options)).toBe(`[BymaxLoggerModule] ${message}`)
  })

  it('still gives no clause for a destination member that is missing', () => {
    const options = {
      ...VALID,
      destinations: [{ name: 'sink' }]
    } as unknown as BymaxLoggerModuleOptions

    expect(refusalOf(options)).toBe(
      '[BymaxLoggerModule] options.destinations[0] must have a write(payload) method'
    )
  })
})

describe('validateOptions: a serializer key is named, not printed', () => {
  /*
   * The key is a name the caller chose, and DEC-188 prints the type of what was refused, not text
   * the caller wrote, so the refusal says "a serializer key" and never the key itself.
   */
  it('refuses a serializer that is not a function without printing its key', () => {
    const options = {
      ...VALID,
      serializers: { [SENTINEL]: 'not a function' }
    } as unknown as BymaxLoggerModuleOptions

    const message = refusalOf(options)

    expect(message).toBe(
      '[BymaxLoggerModule] options.serializers must map every serializer key to a function. Received a string'
    )
    expect(message).not.toContain(SENTINEL)
  })
})
