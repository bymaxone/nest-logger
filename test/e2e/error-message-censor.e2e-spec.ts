/**
 * E2E: the text of an entry that comes from an `Error` (its `message`) is censored under the names
 * of the field it is a copy of, as `err.message` is, so a name in `redactPaths` covers the field and
 * the text. It is not cut at `maxStringLength`, which does not apply to the log message. Exercised
 * the way an application does it: the logger is installed with `app.useLogger`, and every call shape
 * that turns an `Error` into the text of an entry is made.
 *
 * The `stack` of an error repeats its message in its first line and is a different field; it is not
 * what is checked here.
 *
 * Layer: e2e, server (`PinoLoggerService`, the redaction walk, `maxStringLength`).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const LIMIT = 128
const SECRET = 'secret-text-value'

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

type Entry = Record<string, unknown>

/** An application that installs the library's logger, runs `act`, and returns the one entry written after boot. */
async function runOne(
  act: (logger: Logger, service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): Promise<Entry> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-error-message', version: '0.0.0' },
        destinations: [collector],
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.payloads.length
  act(new Logger('LibContext'), app.get(PinoLoggerService))
  await app.close()
  const entries = collector.payloads
    .slice(booted)
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => !String(entry['logKey'] ?? '').startsWith('LOGGER_'))
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(`Expected one entry, got ${String(entries.length)}`)
  }
  return entry
}

/** Every call that makes the message of an `Error` the text of the entry. */
const SHAPES: ReadonlyArray<
  [string, (logger: Logger, service: PinoLoggerService, e: Error) => void]
> = [
  ['service.error(err)', (_l, s, e) => s.error(e)],
  ['Logger.warn(err)', (l, _s, e) => l.warn(e)],
  ['Logger.fatal(err)', (l, _s, e) => l.fatal(e)],
  ['errorStructured', (_l, s, e) => s.errorStructured('LIB_FAILED', e)]
]

describe('Logger E2E — the text of an entry that comes from an Error', () => {
  it.each(SHAPES)('censors the text under a name in redactPaths: %s', async (_label, call) => {
    const entry = await runOne((l, s) => call(l, s, new Error(SECRET)), {
      redactPaths: ['message']
    })

    expect(entry['msg']).not.toContain(SECRET)
    expect((entry['err'] as Entry)['message']).not.toContain(SECRET)
  })

  it.each(SHAPES)('censors the text under redactStrategy paths too: %s', async (_label, call) => {
    const entry = await runOne((l, s) => call(l, s, new Error(SECRET)), {
      redactStrategy: 'paths',
      redactPaths: ['message']
    })

    expect(entry['msg']).not.toContain(SECRET)
    expect((entry['err'] as Entry)['message']).not.toContain(SECRET)
  })

  it.each(SHAPES)(
    'does not cut the text at maxStringLength, which does not apply to the log message: %s',
    async (_label, call) => {
      const entry = await runOne((l, s) => call(l, s, new Error('x'.repeat(100_000))), {
        maxStringLength: LIMIT
      })

      expect(String(entry['msg']).length).toBeGreaterThan(LIMIT * 2)
      expect(entry['msg']).toBe((entry['err'] as Entry)['message'])
    }
  )

  it.each(SHAPES)(
    'leaves the text alone when message is not redacted: %s',
    async (_label, call) => {
      const entry = await runOne((l, s) => call(l, s, new Error('boom')), {
        redactPaths: ['password']
      })

      expect(entry).toMatchObject({ msg: 'boom' })
    }
  )
})
