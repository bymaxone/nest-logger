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
    const line = lineOf({ apiKeys: SECRET, passwords: SECRET }, { redactPaths: ['apiKey'] })

    expect(line).toContain(SECRET)
  })

  it('does not take an empty-looking key for a configured name', () => {
    const line = lineOf({ '\u200b': SECRET, ' ': SECRET }, { redactPaths: ['apiKey'] })

    expect(line).toContain(SECRET)
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
