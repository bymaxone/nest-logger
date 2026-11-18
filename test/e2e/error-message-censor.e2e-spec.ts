/**
 * E2E: the text of an entry that comes from an `Error` (its `message`) is censored under the names
 * of the field it is a copy of, as `err.message` is, so a name in `redactPaths` covers the field and
 * the text. It is not cut at `maxStringLength`, which does not apply to the log message. Exercised
 * the way an application does it: the logger is installed with `app.useLogger`, and every call shape
 * that turns an `Error` into the text of an entry is made.
 *
 * The first lines of the `stack` of an error are its message, so the same text is censored there, in
 * the stack of each cause and in the `exception.*` fields derived from them, whatever the realm or
 * the class of the error.
 *
 * Layer: e2e, server (`PinoLoggerService`, the redaction walk, `maxStringLength`).
 */
import 'reflect-metadata'
import { runInNewContext } from 'node:vm'
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

const SECRET_CAUSE = 'secret-cause-value'

/** A way to make an error that holds `secret`, with a cause that holds `cause`. */
const KINDS: ReadonlyArray<[string, (secret: string, cause: string) => Error]> = [
  ['an Error', (secret, cause) => new Error(secret, { cause: new Error(cause) })],
  [
    'a subclass that names itself',
    (secret, cause) => {
      class ValidationError extends Error {
        constructor(message: string, options: ErrorOptions) {
          super(message, options)
          this.name = 'ValidationError'
        }
      }
      return new ValidationError(secret, { cause: new ValidationError(cause, {}) })
    }
  ],
  [
    'an Error of another realm',
    (secret, cause) =>
      runInNewContext('new Error(secret, { cause: new Error(cause) })', { secret, cause }) as Error
  ]
]

/** The paths of every string in `value` that holds one of the secrets. */
function leaks(value: unknown, path = 'entry'): string[] {
  if (typeof value === 'string') {
    return value.includes(SECRET) || value.includes(SECRET_CAUSE) ? [path] : []
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => leaks(inner, `${path}.${key}`))
}

describe.each(KINDS)('Logger E2E — the stack of %s', (_kind, make) => {
  it.each(SHAPES)(
    'carries the censored message, not the secret, anywhere in the entry: %s',
    async (_label, call) => {
      const entry = await runOne((l, s) => call(l, s, make(SECRET, SECRET_CAUSE)), {
        redactPaths: ['message'],
        errorFormat: 'both'
      })

      expect(leaks(entry)).toEqual([])
      const err = entry['err'] as Entry
      expect(String(err['stack'])).toMatch(/^[^\n]*\[REDACTED\]/)
      expect(String(err['stack'])).toContain('\n    at ')
      expect(String(entry['exception.stacktrace'])).toContain('[REDACTED]')
    }
  )

  it.each(SHAPES)(
    'leaves the stack as it is when message is not redacted: %s',
    async (_l, call) => {
      const entry = await runOne((l, s) => call(l, s, make(SECRET, SECRET_CAUSE)), {
        redactPaths: ['password'],
        errorFormat: 'both'
      })

      expect(String((entry['err'] as Entry)['stack'])).toContain(SECRET)
      expect(entry['exception.message']).toBe(SECRET)
      expect(String(entry['exception.stacktrace'])).toContain(SECRET)
    }
  )
})

describe('Logger E2E — the stack of each error an AggregateError holds', () => {
  it.each(SHAPES)('carries no secret in any member: %s', async (_label, call) => {
    const entry = await runOne(
      (l, s) =>
        call(l, s, new AggregateError([new Error(SECRET), new Error(SECRET_CAUSE)], SECRET)),
      { redactPaths: ['message'], errorFormat: 'both' }
    )

    expect(leaks(entry)).toEqual([])
    const members = (entry['err'] as Entry)['errors'] as Entry[]
    expect(members).toHaveLength(2)
    expect(String(members[0]?.['stack'])).toMatch(/^[^\n]*\[REDACTED\]/)
  })
})

describe('Logger E2E — where the message sits in the stack', () => {
  it.each(SHAPES)(
    'censors a message that holds a control character, which the stack escapes: %s',
    async (_label, call) => {
      const entry = await runOne(
        (l, s) => call(l, s, new Error(`tok\r${SECRET}\u001b${SECRET_CAUSE}`)),
        { redactPaths: ['message'], errorFormat: 'both' }
      )

      expect(leaks(entry)).toEqual([])
      expect(String((entry['err'] as Entry)['stack'])).toMatch(/^[^\n]*\[REDACTED\]/)
    }
  )

  it.each(SHAPES)(
    'censors a message longer than the scan that bounds the stack: %s',
    async (_label, call) => {
      const entry = await runOne(
        (l, s) => call(l, s, new Error(`${SECRET}${'x'.repeat(200_000)}`)),
        { redactPaths: ['message'], errorFormat: 'both' }
      )

      expect(leaks(entry)).toEqual([])
      expect(String((entry['err'] as Entry)['stack'])).toMatch(/^[^\n]*\[REDACTED\]/)
    }
  )

  it.each(SHAPES)(
    'censors the message, and not the name, when the name is the same text: %s',
    async (_label, call) => {
      class Named extends Error {}
      Named.prototype.name = SECRET
      const entry = await runOne((l, s) => call(l, s, new Named(SECRET)), {
        redactPaths: ['message'],
        errorFormat: 'both'
      })

      const err = entry['err'] as Entry
      expect(String(err['stack'])).toContain(`${SECRET}: [REDACTED]`)
      expect(String(err['stack'])).not.toContain(`: ${SECRET}`)
      expect(String(entry['exception.stacktrace'])).toContain(`${SECRET}: [REDACTED]`)
    }
  )

  it.each(SHAPES)(
    'leaves the name whole when the message is a part of it: %s',
    async (_label, call) => {
      class ValidationError extends Error {}
      ValidationError.prototype.name = 'ValidationError'
      const entry = await runOne((l, s) => call(l, s, new ValidationError('Error')), {
        redactPaths: ['message'],
        errorFormat: 'both'
      })

      expect(String((entry['err'] as Entry)['stack'])).toMatch(/^ValidationError: \[REDACTED\]\n/)
      expect(String(entry['exception.stacktrace'])).toMatch(/^ValidationError: \[REDACTED\]\n/)
    }
  )
})
