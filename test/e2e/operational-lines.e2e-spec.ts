/**
 * E2E: the lines the library writes to `stderr` about its own destinations carry library text in
 * `msg` and the host's error as a field. The destination name is host configuration and stays in the
 * `destination` field only, never in `msg`; the error of the host is in `err`, where its `message`
 * passes the same censor as the `message` of an entry (`redactPaths`, `redactCensor`); and a failure
 * at shutdown is a structured line like the others, not a text line that carries a stack.
 *
 * Exercised the way an application does it: the real module is booted with destinations that fail at
 * each stage, a request-free call is logged, and the application is closed.
 *
 * Layer: e2e, server (`DestinationRegistry`, `destinationToStream`, the message censor).
 */
import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const SECRET = 'sk_live_CREDENTIAL_9f3a'
const FRAME = 'FRAME_SENTINEL_77'
const FAILED = 'https://user:' + SECRET + '@db.internal/log'

type Line = Record<string, unknown>

/** A destination named `name` that fails at the stage it is asked to, with an error that holds a secret. */
function failing(name: string, stage: 'init' | 'ready' | 'write' | 'shutdown'): ILogDestination {
  const cause = (): Error => {
    const error = new Error(`connect failed: ${FAILED}`)
    error.stack = `Error: connect failed: ${FAILED}\n    at ${FRAME} (/srv/app.js:1:1)`
    return error
  }
  return {
    name,
    write(): void {
      if (stage === 'write') throw cause()
    },
    onInit(): void {
      if (stage === 'init') throw cause()
    },
    onRegistryReady(): void {
      if (stage === 'ready') throw cause()
    },
    onShutdown(): void {
      if (stage === 'shutdown') throw cause()
    }
  }
}

const STAGES = ['init', 'ready', 'write', 'shutdown'] as const

/** Boot the real module with one failing destination per stage, log once, close, and return every byte written to stderr. */
async function runAll(extra: Partial<BymaxLoggerModuleOptions>): Promise<string[]> {
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  const destinations = STAGES.map((stage) => failing(`NAME_${stage.toUpperCase()}`, stage))

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-operational', version: '0.0.0' },
        destinations,
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.get(PinoLoggerService).info('APP_EVENT', 'an entry of the application')
  await app.close()
  const written = stderr.mock.calls.map((call) => String(call[0]))
  stderr.mockRestore()
  return written
}

/** The structured lines among what was written, and what was written that is not one. */
function split(written: string[]): { lines: Line[]; text: string[] } {
  const lines: Line[] = []
  const text: string[] = []
  for (const chunk of written) {
    for (const part of chunk.split('\n').filter((p) => p !== '')) {
      try {
        lines.push(JSON.parse(part) as Line)
      } catch {
        text.push(part)
      }
    }
  }
  return { lines, text }
}

describe('Logger E2E — the lines the library writes about its destinations', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('writes every failure at every stage as a structured line, and the host error in no text line', async () => {
    const { lines, text } = split(await runAll({}))
    const failures = lines.filter((line) => String(line['logKey']).startsWith('LOGGER_DESTINATION'))

    expect(failures.map((line) => line['destination']).sort()).toEqual(
      STAGES.map((stage) => `NAME_${stage.toUpperCase()}`).sort()
    )
    expect(text.filter((line) => /Shutdown failed|connect failed/.test(line))).toEqual([])
    expect(text.join('\n')).not.toContain(SECRET)
  })

  it('writes the failure at shutdown under its own key, as an error', async () => {
    const { lines } = split(await runAll({}))
    const shutdown = lines.find((line) => line['destination'] === 'NAME_SHUTDOWN')

    expect(shutdown).toMatchObject({
      level: 'error',
      logKey: 'LOGGER_DESTINATION_SHUTDOWN_FAILED',
      destination: 'NAME_SHUTDOWN',
      err: { type: 'Error' }
    })
  })

  it('keeps the destination name out of msg, which is library text', async () => {
    const { lines } = split(await runAll({}))
    const failures = lines.filter((line) => String(line['logKey']).startsWith('LOGGER_DESTINATION'))

    for (const line of failures) {
      expect(String(line['msg'])).not.toContain('NAME_')
      expect(String(line['msg'])).not.toContain(SECRET)
    }
    expect(failures).toHaveLength(STAGES.length)
  })

  it('does not write the stack of the error of the host in any byte', async () => {
    const written = (await runAll({})).join('')

    expect(written).not.toContain(FRAME)
  })

  it('holds the error of the host only in err.message while nothing censors it', async () => {
    const { lines } = split(await runAll({}))

    for (const line of lines.filter((l) => String(l['logKey']).startsWith('LOGGER_DESTINATION'))) {
      const { err, ...rest } = line
      expect((err as Line)['message']).toBe(`connect failed: ${FAILED}`)
      expect(JSON.stringify(rest)).not.toContain(SECRET)
    }
  })

  it.each([
    ['names', { redactPaths: ['message'] }],
    ['paths', { redactStrategy: 'paths' as const, redactPaths: ['message'] }],
    ['a censor of its own', { redactPaths: ['message'], redactCensor: '<hidden>' }]
  ])('passes err.message through the censor of an entry: %s', async (_label, extra) => {
    const written = await runAll(extra)
    const { lines } = split(written)
    const failures = lines.filter((line) => String(line['logKey']).startsWith('LOGGER_DESTINATION'))

    expect(written.join('')).not.toContain(SECRET)
    expect(failures).toHaveLength(STAGES.length)
    for (const line of failures) {
      expect((line['err'] as Line)['message']).toBe(
        'redactCensor' in extra ? '<hidden>' : '[REDACTED]'
      )
    }
  })
})
