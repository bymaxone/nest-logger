/**
 * Pins that a configured redact name, and the default names, hide a field however its key is spelled:
 * the comparison folds both sides, so a zero-width character, a soft hyphen, a byte order mark, a
 * fullwidth or Cyrillic letter, a space, a tab, a combining mark, a dotless i or a separator in the key
 * does not let the value through, at the top of an entry and below it.
 *
 * Layer: server, tests. Driven through the real factory.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SECRET = 'SEC_9f3a'

/** The line written for `{ event, ...payload }` under `extra`. */
function lineOf(
  payload: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): string {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', ...payload })
  return lines[0] ?? ''
}

/** Spellings of one key that a backend that normalises names, or a reader, takes for the same name. */
const SPELLINGS = (name: string): string[] => [
  name,
  name.toUpperCase(),
  `${name.slice(0, 2)}\u200b${name.slice(2)}`,
  `${name.slice(0, 2)}\u200d${name.slice(2)}`,
  `${name.slice(0, 2)}\u00ad${name.slice(2)}`,
  `\ufeff${name}`,
  `\u2060${name}`,
  `${name.slice(0, 2)}\u00a0${name.slice(2)}`,
  `${name.slice(0, 2)}\t${name.slice(2)}`,
  `${name} `,
  ` ${name}`,
  `${name.slice(0, 1)}\u0301${name.slice(1)}`,
  `${name.slice(0, 2)}.${name.slice(2)}`,
  `${name.slice(0, 2)}_${name.slice(2)}`,
  `${name.slice(0, 2)}-${name.slice(2)}`,
  name.replace(/[ao]/, (letter) => (letter === 'a' ? '\uff41' : '\uff4f')),
  name.replace(/[ao]/, (letter) => (letter === 'a' ? '\u0430' : '\u043e')),
  `${name.slice(0, 2)}\u3164${name.slice(2)}`,
  name.replace('i', '\u0131')
]

describe.each([
  ['a configured name', { redactPaths: ['apiKey'] }, 'apiKey'],
  ['a default name', {}, 'password'],
  ['another default name', {}, 'authorization'],
  ['the leaf of a configured path', { redactPaths: ['a.b.tok'] }, 'tok']
])('%s', (_label, options, name) => {
  it.each(SPELLINGS(name))('hides a value under %j at the top', (key) => {
    expect(lineOf({ [key]: SECRET }, options)).not.toContain(SECRET)
  })

  it.each(SPELLINGS(name))('hides a value under %j below the top', (key) => {
    expect(lineOf({ meta: { deep: { [key]: SECRET } } }, options)).not.toContain(SECRET)
  })
})

describe('the folded comparison', () => {
  it('leaves a key that is another word alone', () => {
    const line = lineOf(
      { apiKeys: `${SECRET}_A`, passwords: `${SECRET}_B` },
      { redactPaths: ['apiKey'] }
    )

    expect(line).toContain(`${SECRET}_A`)
    expect(line).toContain(`${SECRET}_B`)
  })

  it('does not take an empty-looking key for a configured name', () => {
    const line = lineOf(
      { '\u200b': `${SECRET}_A`, ' ': `${SECRET}_B` },
      { redactPaths: ['apiKey'] }
    )

    expect(line).toContain(`${SECRET}_A`)
    expect(line).toContain(`${SECRET}_B`)
  })

  it('hides the value beside a header whose name is spelled another way, in a raw header array', () => {
    const line = lineOf({
      meta: { rawHeaders: ['Author\u200bization', SECRET, 'Accept', 'text/html'] }
    })

    expect(line).not.toContain(SECRET)
    expect(line).toContain('text/html')
  })
})

describe('raw headers', () => {
  it('hides the value beside a header name spelled plainly, which is the control', () => {
    const line = lineOf({ meta: { rawHeaders: ['Authorization', SECRET, 'Accept', 'text/html'] } })

    expect(line).not.toContain(SECRET)
  })
})

describe('the default names that hold a separator', () => {
  it.each([
    'x-api-key',
    'X-Api-Key',
    'x_api_key',
    'xApiKey',
    'set-cookie',
    'Set-Cookie',
    'x-auth-token'
  ])('hide a value under %s', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
    expect(lineOf({ meta: { nested: { [key]: SECRET } } })).not.toContain(SECRET)
  })

  it('hide the value beside such a name in a raw header array', () => {
    const line = lineOf({ meta: { rawHeaders: ['X-API-KEY', SECRET, 'Accept', 'text/html'] } })

    expect(line).not.toContain(SECRET)
  })
})

describe('the names hide a key spelled with a hyphen or a letter the folding does not know', () => {
  it.each([
    ['x\u2011api\u2011key'],
    ['access\u2010token'],
    ['api\u2212key'],
    ['set\u2011cookie'],
    ['password\u2011hash'],
    ['x\u2013api\u2013key'],
    ['pass:word'],
    ['pass/word'],
    ['pass#word'],
    ['aut\u04bborization'],
    ['a\u057dthorization'],
    ['authoriz\u0251tion'],
    ['p\u0251ssword'],
    ['pa\u057dsword'],
    ['to\u0138en'],
    ['\u2010password\u2010']
  ])('hide a value under %j, at the top and below it', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
    expect(lineOf({ meta: { nested: { [key]: SECRET } } })).not.toContain(SECRET)
  })

  it('hide the value beside such a name in a raw header array', () => {
    const line = lineOf({
      meta: { rawHeaders: ['x\u2011api\u2011key', SECRET, 'aut\u04bborization', `${SECRET}2`] }
    })

    expect(line).not.toContain(SECRET)
  })

  it('hide the value under such a name inside a header object', () => {
    expect(lineOf({ meta: { headers: { 'set\u2011cookie': SECRET } } })).not.toContain(SECRET)
  })

  it.each([
    ['author'],
    ['authorize'],
    ['passwords'],
    ['pr\u00e9nom'],
    ['\u017c\u00f3\u0142\u0107'],
    ['x-trace-id']
  ])('leave a legitimate key %j alone', (key) => {
    expect(lineOf({ [key]: SECRET })).toContain(SECRET)
  })
})

describe('a key that is a spelling of a name and a key that is only another script', () => {
  it.each([
    ['pa\u00dfword'],
    ['acce\u00dftoken'],
    ['x\u2011api\u2011k\u0113y'],
    ['au\u00feorization']
  ])('hides a value under %j', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
  })

  it.each([
    ['\u7528\u6237\u540d'],
    ['\u540d\u524d'],
    ['\u0434\u0430\u043d\u043d\u044b\u0435'],
    ['\u05e9\u05dd'],
    ['\u044f'.repeat(3)],
    ['\u044f'.repeat(24)]
  ])('keeps a caller field %j, neither hidden nor dropped', (key) => {
    const line = JSON.parse(lineOf({ meta: { [key]: SECRET }, [key]: `${SECRET}2` })) as {
      meta: Record<string, string>
    }

    expect(line.meta[key]).toBe(SECRET)
    expect(JSON.stringify(line)).toContain(`${SECRET}2`)
  })
})

describe('a name spelled with a letter that stands for more than one Latin letter', () => {
  it.each([
    ['TOKE\u039d'],
    ['\u00feassword'],
    ['\u00dfassword'],
    ['pa\u00dfword'],
    ['au\u00feorization'],
    ['\u00feasswo\u0433d'],
    ['pass\u0153rd']
  ])('hides a value under %j', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
  })

  it('hides a value under a spelling of a configured name with the letter that looks like its first', () => {
    expect(lineOf({ '\u00dfearer': SECRET }, { redactPaths: ['bearer'] })).not.toContain(SECRET)
  })

  it.each([['user\u7528\u6237'], ['user\u540d\u79f0'], ['m\u6d88\u606f'], ['time\ud55c\uae00']])(
    'keeps a caller field %j that a word of another script follows a Latin word in',
    (key) => {
      const line = JSON.parse(lineOf({ meta: { [key]: SECRET }, [key]: `${SECRET}2` })) as {
        meta: Record<string, string>
      }

      expect(line.meta[key]).toBe(SECRET)
      expect(JSON.stringify(line)).toContain(`${SECRET}2`)
    }
  )
})

describe('a name spelled with letters that look like more than one Latin letter or like two', () => {
  it.each([
    ['C\u0406ientSecret'],
    ['c\u0399ientsecret'],
    ['cl\u0131entSecret'],
    ['clientSecret'.replace('l', '\u026a')],
    ['\ua737thorization'],
    ['c\ua74fkie'],
    ['set-c\ua74fkie'],
    ['t\u3147ken'],
    ['passw\u05e1rd'],
    ['p\u0430\u0455sword']
  ])('hides a value under %j', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
  })

  it.each([['logKe\u02b9'], ['user_\u0438\u0434'], ['lev\u0394l'], ['trace\u0251Id']])(
    'does not drop a caller field %j, which is not the owned key it resembles',
    (key) => {
      const line = JSON.parse(lineOf({ [key]: SECRET })) as Record<string, string>

      expect(line[key]).toBe(SECRET)
    }
  )
})

describe('the key that marks a flat header array', () => {
  it.each([
    ['rawTra\u0131lers'],
    ['rawTra\u0456lers'],
    ['rawTra\u026alers'],
    ['raw\u0397eaders'],
    ['rawHeader\u015f'],
    ['raw-Headers'],
    ['RAW_HEADERS']
  ])('hides the value beside a sensitive name in a header array under %j', (key) => {
    const line = lineOf({ meta: { [key]: ['Authorization', SECRET, 'Accept', 'text/html'] } })

    expect(line).not.toContain(SECRET)
  })
})
