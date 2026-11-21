/**
 * Pins that an option which decides what is redacted is read by name, whichever way the host supplies
 * it: as a property, as a non-enumerable getter, as the answer of a Proxy that lists no key, and as a
 * getter of a class. A copy that enumerated the options would drop the last three and turn the
 * redaction off without a word; here each way still redacts the sentinel it must.
 *
 * Layer: server/config, tests. Driven through the module registration and the real factory.
 */
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import { BymaxLoggerModule } from '../logger.module'
import { buildPinoInstance } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

const SENTINEL = 'SENTINEL_9f3a'
const SERVICE = { name: 'api', version: '1.0.0' }

type Supply = (key: string, value: unknown) => Record<string, unknown>

/** The four ways to hand one option to the module. */
const WAYS: ReadonlyArray<readonly [string, Supply]> = [
  ['a property', (key, value) => ({ service: SERVICE, [key]: value })],
  [
    'a non-enumerable getter',
    (key, value) =>
      Object.defineProperty({ service: SERVICE }, key, {
        enumerable: false,
        get: () => value
      })
  ],
  [
    'the answer of a Proxy that lists no key',
    (key, value) =>
      new Proxy(
        {},
        {
          get: (_target, name) => (name === 'service' ? SERVICE : name === key ? value : undefined)
        }
      ) as Record<string, unknown>
  ],
  [
    'a getter of a class',
    (key, value) => {
      class Given {
        service = SERVICE
        get [key](): unknown {
          return value
        }
      }
      return new Given() as unknown as Record<string, unknown>
    }
  ]
]

/** The options as the module resolves them from `given`. */
function resolve(given: Record<string, unknown>): ResolvedBymaxLoggerModuleOptions {
  const provider = (BymaxLoggerModule.forRoot(given as never).providers ?? []).find(
    (candidate) =>
      typeof candidate === 'object' &&
      'provide' in candidate &&
      candidate.provide === LOGGER_OPTIONS_TOKEN
  ) as { useValue: ResolvedBymaxLoggerModuleOptions }
  return provider.useValue
}

/** The entry written for `payload` under the options resolved from `given`. */
function entryOf(given: Record<string, unknown>, payload: Record<string, unknown>): string {
  const lines: string[] = []
  const options = resolve(given)
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'sink', write: (line: unknown) => lines.push(String(line)) } as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', ...payload })
  return lines[0] ?? ''
}

describe.each(WAYS)('an option supplied as %s', (_way, supply) => {
  it('redactPaths still redacts the field it names', () => {
    const line = entryOf(supply('redactPaths', ['topSecret']), { topSecret: SENTINEL })

    expect(line).not.toContain(SENTINEL)
    expect(line).toContain('[REDACTED]')
  })

  it('redactCensor is still the text that replaces it', () => {
    const line = entryOf(supply('redactCensor', '<<CENSOR>>'), { password: SENTINEL })

    expect(line).not.toContain(SENTINEL)
    expect(line).toContain('<<CENSOR>>')
  })

  it("redactStrategy 'paths' is still the strategy: a name below the top is only matched by a path", () => {
    const given = supply('redactStrategy', 'paths')
    const line = entryOf(given, { topSecret: SENTINEL, nested: { topSecret: SENTINEL } })

    expect(line).toContain(SENTINEL)
  })

  it('shouldDisableDefaultRedact is still read: the default names stay on when it is false', () => {
    const line = entryOf(supply('shouldDisableDefaultRedact', false), { password: SENTINEL })

    expect(line).not.toContain(SENTINEL)
  })

  it('shouldDisableDefaultRedact true is still read: the default names are off', () => {
    const line = entryOf(supply('shouldDisableDefaultRedact', true), { password: SENTINEL })

    expect(line).toContain(SENTINEL)
  })
})
