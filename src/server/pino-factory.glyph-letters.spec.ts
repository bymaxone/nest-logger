/**
 * Pins that a key spelled with symbols drawn as Latin letters (the negative circled and negative squared
 * letters, the regional indicators), which Unicode gives no compatibility form, hides a value like the
 * name it spells, at the top of an entry, below it, in a flat header array and as a property of an Error.
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

/** `name` with each of its letters drawn from the block that starts at `first` (capital A of the block). */
const drawn = (name: string, first: number): string =>
  [...name.toUpperCase()]
    .map((letter) => String.fromCodePoint(first + letter.charCodeAt(0) - 65))
    .join('')

const BLOCKS = [
  ['negative circled', 0x1f150],
  ['negative squared', 0x1f170],
  ['regional indicator', 0x1f1e6]
] as const

describe.each(BLOCKS)('a name drawn with %s letters', (_label, first) => {
  it.each(['token', 'password', 'secret', 'cookie', 'authorization'])(
    'hides a value under %s, at the top, below it, in a header array and on an Error',
    (name) => {
      const key = drawn(name, first)

      expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
      expect(lineOf({ meta: { nested: { [key]: SECRET } } })).not.toContain(SECRET)
      expect(lineOf({ meta: { rawHeaders: [key, SECRET, 'Accept', 'text/html'] } })).not.toContain(
        SECRET
      )
      expect(lineOf({ err: Object.assign(new Error('benign'), { [key]: SECRET }) })).not.toContain(
        SECRET
      )
    }
  )

  it('hides a configured name drawn this way', () => {
    expect(lineOf({ [drawn('apiKey', first)]: SECRET }, { redactPaths: ['apiKey'] })).not.toContain(
      SECRET
    )
  })

  it('keeps a key that only shares some of its letters', () => {
    expect(lineOf({ [drawn('tokens', first)]: SECRET })).toContain(SECRET)
  })
})
