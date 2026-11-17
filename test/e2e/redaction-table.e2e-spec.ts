/**
 * E2E: a table of every way text or fields reach an entry, each carrying a key the consumer asked to
 * redact and a sentinel secret, under both redaction strategies. The sentinel must never appear in
 * the line a destination receives, and every row has a positive control (its own marker is in the
 * line), so a row that wrote nothing cannot pass.
 *
 * Layer: e2e, server (the whole logger through the module wiring). The nested rows run under the
 * `names` strategy only: the `paths` strategy is the legacy escape hatch and censors the root keys
 * it lists, not a key at any depth.
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const SENTINEL = 'SENTINEL-secret-9f3a'
type Strategy = 'names' | 'paths'

class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly lines: string[] = []

  write(payload: string): void {
    this.lines.push(payload)
  }
}

/** Runs `act` through a real application and returns every line written after boot. */
async function lines(
  act: (logger: Logger, service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions>
): Promise<string[]> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-redaction-table', version: '0.0.0' },
        destinations: [collector],
        level: 'trace',
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.lines.length
  act(new Logger('Table'), app.get(PinoLoggerService))
  await app.close()
  return collector.lines.slice(booted).filter((line) => !line.includes('"LOGGER_'))
}

interface Row {
  readonly name: string
  readonly nested?: true
  readonly emit: (key: string, mark: string, logger: Logger, service: PinoLoggerService) => void
}

/** Each entry point, with the redacted key `key` carrying the sentinel and a marker `mark`. */
const ENTRY_POINTS: readonly Row[] = [
  { name: 'object message', emit: (k, m, l) => l.warn({ marker: m, [k]: SENTINEL }) },
  { name: 'object message, error level', emit: (k, m, l) => l.error({ marker: m, [k]: SENTINEL }) },
  { name: 'object message, fatal level', emit: (k, m, l) => l.fatal({ marker: m, [k]: SENTINEL }) },
  { name: 'object message, debug level', emit: (k, m, l) => l.debug({ marker: m, [k]: SENTINEL }) },
  {
    name: 'object message, nested',
    nested: true,
    emit: (k, m, l) => l.warn({ marker: m, deep: { more: { [k]: SENTINEL } } })
  },
  {
    name: 'metadata of info',
    emit: (k, m, _l, s) => s.info('ROW_INFO', 'text', undefined, { marker: m, [k]: SENTINEL })
  },
  {
    name: 'metadata of warnStructured',
    emit: (k, m, _l, s) =>
      s.warnStructured('ROW_WARN', 'text', undefined, { marker: m, [k]: SENTINEL })
  },
  {
    name: 'metadata of errorStructured',
    emit: (k, m, _l, s) =>
      s.errorStructured('ROW_ERROR', new Error('boom'), undefined, { marker: m, [k]: SENTINEL })
  },
  {
    name: 'error-shaped object',
    emit: (k, m, l) => l.warn({ name: 'DriverError', message: m, [k]: SENTINEL })
  },
  {
    name: 'Error with an own field',
    emit: (k, m, l) => l.error(Object.assign(new Error(m), { [k]: SENTINEL }))
  },
  {
    name: 'child bindings',
    emit: (k, m, _l, s) => s.child({ marker: m, [k]: SENTINEL }).warn('child line')
  },
  {
    name: 'raw Pino logger',
    emit: (k, m, _l, s) => s.getRawLogger().info({ marker: m, [k]: SENTINEL }, 'raw line')
  }
]

describe.each(['names', 'paths'] as const)(
  'the redaction table, strategy %s',
  (strategy: Strategy) => {
    describe.each(['password', 'customsecret'])('key %s', (key) => {
      const extra: Partial<BymaxLoggerModuleOptions> = {
        redactStrategy: strategy,
        redactPaths: ['customsecret']
      }

      it.each(ENTRY_POINTS.filter((row) => row.nested !== true || strategy === 'names'))(
        'never writes the sentinel through $name',
        async (row) => {
          const written = await lines(
            (logger, service) => row.emit(key, 'ROW-MARKER', logger, service),
            extra
          )

          expect(written.join('\n')).toContain('ROW-MARKER')
          expect(written.join('\n')).not.toContain(SENTINEL)
        }
      )
    })

    /*
     * The text of an object message is a copy of its `message` or `event` field, and the text of an
     * error-shaped object is its `message`: each is checked with that very name in redactPaths.
     */
    describe.each(['message', 'event'])('text taken from %s', (textKey) => {
      const extra: Partial<BymaxLoggerModuleOptions> = {
        redactStrategy: strategy,
        redactPaths: [textKey]
      }

      it('never writes the sentinel as the entry text of an object message', async () => {
        const written = await lines(
          (logger) => logger.warn({ marker: 'TEXT-MARKER', [textKey]: SENTINEL }),
          extra
        )

        expect(written.join('\n')).toContain('TEXT-MARKER')
        expect(written.join('\n')).not.toContain(SENTINEL)
      })
    })
  }
)

describe('what the table does not claim', () => {
  /*
   * Redaction is by field name. A string message is the caller's own text, with no name to censor
   * by, so a secret written into it is written; the row pins that so the boundary is not a surprise.
   */
  it('writes the text of a string message as given', async () => {
    const written = await lines((logger) => logger.warn(`plain text ${SENTINEL}`), {
      redactPaths: ['customsecret']
    })

    expect(written.join('\n')).toContain(SENTINEL)
  })
})
