/**
 * Verifies that the built-ins the redaction reads are the ones the logger was imported with: one replaced
 * afterwards (`Set.prototype.has` that answers `undefined`, a `toLowerCase` that does nothing, the `next`
 * of a string iterator that is always done) makes a record be dropped and a URL path be redacted whole,
 * and never lets a secret through. Each replacement is made around a logger built and used inside it,
 * and around one built before it.
 *
 * Layer: server, tests. Driven through the real factory, in one process, with the member put back.
 */
import { resolveOptions } from './config/resolve-options'
import {
  GUARDED_BUILTINS,
  allMatches,
  capturedSet,
  pinoBuiltinsIntact,
  replaceAllText
} from './utils/captured-builtins.util'
import {
  normalizeUrl,
  scrubSecretSegments,
  secretPathSegments,
  withoutRequestSecrets
} from './utils/normalize-url.util'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

// Held here, because the member being replaced may be the one the harness would restore it with.
const define = Object.defineProperty
const describeMember = Object.getOwnPropertyDescriptor
const remove = Reflect.deleteProperty

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
const LEAK = /sEcReT\d+xyz/

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
    'custom​Key': TOKENS[8]
  } as never)
  logger.error(new Error(`${TOKENS[5] ?? ''} boom`), 'ctx')
}

type Replacement = (this: unknown, ...args: unknown[]) => unknown

/** What the logger writes while `holder[key]` is replaced by `replacement`, which answers nothing. */
function writtenWith(
  holder: object,
  key: string | symbol,
  prebuilt: Built | undefined,
  replacement: Replacement = () => undefined
): { lines: string[]; threw: boolean } {
  const original = describeMember(holder, key)
  define(holder, key, {
    value: replacement,
    writable: true,
    configurable: true,
    enumerable: original?.enumerable ?? false
  })
  try {
    const built = prebuilt ?? build()
    write(built.logger)
    return { lines: built.lines, threw: false }
  } catch {
    return { lines: [], threw: true }
  } finally {
    if (original === undefined) remove(holder, key)
    else define(holder, key, original)
  }
}

/** What `holder[key]` is replaced by in a case: an iterator step that is always done, or a method that answers nothing. */
function replacementFor(key: string | symbol, kind: 'empty' | 'identity'): Replacement {
  if (key === 'next') return () => ({ done: true, value: undefined })
  if (kind === 'identity') {
    return function (this: unknown): unknown {
      return String(this)
    }
  }
  return () => undefined
}

/** One case for each member of the table, replaced by each kind of answer. */
const MEMBERS = GUARDED_BUILTINS.flatMap(([holder, members], entry) =>
  members.flatMap((member) =>
    (['empty', 'identity'] as const).map(
      (kind) => [`${entry}:${String(member)} (${kind})`, holder, member, kind] as const
    )
  )
)

describe('a built-in replaced after the logger is imported', () => {
  const baseline = build()
  write(baseline.logger)

  /**
   * Given any built-in member the redaction of a record reads, replaced by one that answers nothing or
   * by one that returns the text it was given
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then no secret is written: the record is dropped, or the logger is not built
   */
  it.each(MEMBERS)('%s writes no secret and no record', (_name, holder, member, kind) => {
    for (const prebuilt of [build(), undefined]) {
      const { lines } = writtenWith(holder, member, prebuilt, replacementFor(member, kind))

      expect(lines.join('\n')).not.toMatch(LEAK)
      expect(lines).toHaveLength(0)
    }
  })

  /**
   * Given a built-in that this library no longer reads (the `matchAll` of a pattern, the `replaceAll` of
   * a string), replaced by one that answers nothing
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then the lines are the baseline's, since nothing the redaction decides with was touched
   */
  it.each([
    ['RegExp.prototype[Symbol.matchAll]', RegExp.prototype, Symbol.matchAll],
    ['String.prototype.replaceAll', String.prototype, 'replaceAll']
  ] as const)('%s is not read, so the record is written and hidden', (_name, holder, key) => {
    for (const prebuilt of [build(), undefined]) {
      const { lines, threw } = writtenWith(holder, key, prebuilt, function* () {})

      expect(threw).toBe(false)
      expect(lines.join('\n')).not.toMatch(LEAK)
      expect(lines).toHaveLength(baseline.lines.length)
    }
  })

  /**
   * Given a member of the table put back as the very function it was
   * When a logger built before it, and a logger built inside it, write the record of secrets
   * Then nothing is dropped: only a replacement is refused
   */
  it('drops nothing for a member that is assigned the function it already was', () => {
    for (const prebuilt of [build(), undefined]) {
      const { lines, threw } = writtenWith(
        Array.prototype,
        'map',
        prebuilt,
        Array.prototype.map as Replacement
      )

      expect(threw).toBe(false)
      expect(lines).toHaveLength(baseline.lines.length)
      expect(lines.join('\n')).not.toMatch(LEAK)
    }
  })

  /**
   * Given built-ins a host replaces by design (a wrapped `then`, fake timers and a fake `Date`)
   * When a logger built before them, and one built inside them, write the record of secrets
   * Then nothing is dropped: they are not read by the redaction
   */
  it('drops nothing while a host wraps Promise.then or fakes Date and the timers', () => {
    const wrapped = Promise.prototype.then
    const clock = Date.now
    const timer = globalThis.setTimeout
    for (const prebuilt of [build(), undefined]) {
      const { lines, threw } = writtenWith(
        Promise.prototype,
        'then',
        prebuilt,
        function (this: unknown, ...args: unknown[]) {
          return Reflect.apply(wrapped, this, args)
        }
      )
      const faked = writtenWith(Date, 'now', undefined, () => 0)
      const timed = writtenWith(
        globalThis,
        'setTimeout',
        undefined,
        timer as unknown as Replacement
      )

      expect(threw).toBe(false)
      expect(lines).toHaveLength(baseline.lines.length)
      expect(faked.lines).toHaveLength(baseline.lines.length)
      expect(timed.lines).toHaveLength(baseline.lines.length)
    }
    expect(Date.now).toBe(clock)
  })

  /**
   * Given options resolved while the built-ins were intact (a derived backend skips `resolveOptions`)
   * When a built-in is replaced and the factory builds a logger from them
   * Then the factory refuses, since a logger built then would carry the answer for good
   */
  it('refuses to build from resolved options while a built-in is replaced', () => {
    const resolved = resolveOptions({ service: { name: 'app', version: '1.0.0' } })
    const health = new DestinationHealth()
    const context = new LogContextService()
    const sink = { name: 'sink', write: () => undefined }
    const original = describeMember(Set.prototype, 'has') as PropertyDescriptor
    define(Set.prototype, 'has', { ...original, value: () => undefined })
    try {
      expect(() => buildPinoInstance(resolved, context, [sink as never], health)).toThrow(
        'LOGGER_BUILTINS_REPLACED'
      )
    } finally {
      define(Set.prototype, 'has', original)
    }
  })

  it('has secrets in the record to hide, which the baseline hides', () => {
    expect(pinoBuiltinsIntact()).toBe(true)
    expect(baseline.lines.length).toBeGreaterThan(1)
    expect(baseline.lines.join('\n')).not.toMatch(LEAK)
  })
})

/**
 * Given a URL path with a credential in it, and a built-in the scan of the path reads that was replaced
 * When the path is scrubbed, normalized, and read for its credential segments, and a message is cleaned
 * Then the whole path, or text, is redacted, and nothing of it is returned
 */
describe('a URL path read while a built-in was replaced', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const url = `/reset/${jwt}/done`

  function whileReplaced<T>(holder: object, key: string, read: () => T): T {
    const original = describeMember(holder, key) as PropertyDescriptor
    define(holder, key, { ...original, value: () => false })
    try {
      return read()
    } finally {
      define(holder, key, original)
    }
  }

  it('reads the path as it is while nothing is replaced', () => {
    expect(scrubSecretSegments(url)).toBe('/reset/:redacted/done')
    expect(normalizeUrl(url)).toBe('/reset/:redacted/done')
    expect(secretPathSegments(url)).toEqual([jwt])
    expect(withoutRequestSecrets(`GET ${url}`, [], url)).toBe('GET /reset/:redacted/done')
  })

  it('redacts the whole path when RegExp.prototype.test says nothing is a credential', () => {
    const read = (): string[] => [
      scrubSecretSegments(url),
      normalizeUrl(url),
      withoutRequestSecrets(`GET ${url}`, [], url)
    ]

    const results = whileReplaced(RegExp.prototype, 'test', read)

    expect(results.join('\n')).not.toContain(jwt)
    expect(results.slice(0, 2)).toEqual(['/:redacted', '/:redacted'])
    // What is to be cut out of a text is the whole path, since no segment of it is trusted.
    expect(whileReplaced(RegExp.prototype, 'test', () => secretPathSegments(url))).toEqual([url])
  })

  it('redacts the whole path when the pattern of the host would be skipped', () => {
    const results = whileReplaced(Array.prototype, 'some', () => [
      scrubSecretSegments(url, [/reset/]),
      withoutRequestSecrets(`token ${jwt}`, [/./], url)
    ])

    expect(results.join('\n')).not.toContain(jwt)
  })
})

/**
 * Given a global pattern, a text and a pattern that can match nothing
 * When every match is read
 * Then they come in order, the position is left at the start, and an empty match ends the walk
 */
describe('allMatches', () => {
  it('reads every match in order and leaves the position at the start', () => {
    const pattern = /[a-z]+/g

    const found = allMatches(pattern, 'ab.cd')

    expect(found.map((match) => match[0])).toEqual(['ab', 'cd'])
    expect(pattern.lastIndex).toBe(0)
  })

  it('stops at an empty match instead of walking forever', () => {
    expect(allMatches(/x*/g, 'ab')).toEqual([])
  })
})

/**
 * Given a plain search that occurs several times, once and not at all
 * When it is replaced
 * Then every occurrence is replaced, a `$` in the replacement stays as written, and an empty search changes nothing
 */
describe('replaceAllText', () => {
  it('replaces every occurrence of a plain search', () => {
    expect(replaceAllText('a_b_c', '_', '.')).toBe('a.b.c')
    expect(replaceAllText('abc', 'b', '$&')).toBe('a$&c')
    expect(replaceAllText('abc', 'x', '.')).toBe('abc')
  })

  it('leaves the text alone for an empty search', () => {
    expect(replaceAllText('abc', '', '.')).toBe('abc')
  })
})

/**
 * Given a set made by `capturedSet`, and `Set.prototype.has` and `add` replaced afterwards
 * When the set is read and added to
 * Then its own `has` and `add` answer as the real ones did, so a call on it does not read the prototype
 */
describe('capturedSet', () => {
  it('answers through its own has and add, not through Set.prototype', () => {
    const set = capturedSet<string>(['a'])
    expect(Object.hasOwn(set, 'has')).toBe(true)
    expect(Object.hasOwn(set, 'add')).toBe(true)
    const hasOriginal = describeMember(Set.prototype, 'has') as PropertyDescriptor
    const addOriginal = describeMember(Set.prototype, 'add') as PropertyDescriptor
    define(Set.prototype, 'has', { ...hasOriginal, value: () => false })
    define(Set.prototype, 'add', { ...addOriginal, value: () => undefined })
    try {
      set.add('b')
      expect([set.has('a'), set.has('b'), set.has('c')]).toEqual([true, true, false])
    } finally {
      define(Set.prototype, 'has', hasOriginal)
      define(Set.prototype, 'add', addOriginal)
    }
  })
})

/**
 * Given a built-in the options are read with, replaced
 * When options are resolved
 * Then resolving refuses with the named error, before anything is read
 */
describe('resolveOptions while a built-in is replaced', () => {
  it('refuses with LOGGER_BUILTINS_REPLACED', () => {
    const original = describeMember(Set.prototype, 'has') as PropertyDescriptor
    define(Set.prototype, 'has', { ...original, value: () => undefined })
    try {
      expect(() => resolveOptions({ service: { name: 'app', version: '1.0.0' } })).toThrow(
        'LOGGER_BUILTINS_REPLACED'
      )
    } finally {
      define(Set.prototype, 'has', original)
    }
  })
})
