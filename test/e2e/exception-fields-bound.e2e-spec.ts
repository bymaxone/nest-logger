/**
 * E2E: with `errorFormat` writing the SemConv fields, a huge error message, name and stack reach a
 * destination with each derived `exception.*` and `error.type` field cut to `maxEntrySizeBytes`, in
 * UTF-8 bytes, and a serializer that returns a value JSON cannot measure is replaced by a
 * truncation envelope instead of reaching the line unbounded. Through a real Nest application.
 *
 * Layer: e2e, server (the record formatter, `createSizeBoundedSerializer`).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { BymaxLoggerModuleOptions, ILogDestination } from '@bymax-one/nest-logger'

const CEILING = 1024

class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly lines: string[] = []

  write(payload: string): void {
    this.lines.push(payload)
  }
}

async function entry(
  act: (logger: Logger) => void,
  extra: Partial<BymaxLoggerModuleOptions>
): Promise<Record<string, unknown>> {
  const collector = new Collector()

  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-exception-bound', version: '0.0.0' },
        destinations: [collector],
        maxEntrySizeBytes: CEILING,
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const booted = collector.lines.length
  act(new Logger('Bound'))
  await app.close()
  const lines = collector.lines.slice(booted).filter((line) => !line.includes('"logKey":"LOGGER_'))
  const [line] = lines
  if (lines.length !== 1 || line === undefined)
    throw new Error(`Expected one line, got ${String(lines.length)}`)
  return JSON.parse(line) as Record<string, unknown>
}

describe('Logger E2E — the derived exception fields', () => {
  it.each(['exception.type', 'exception.message', 'exception.stacktrace', 'error.type'])(
    'cuts %s to maxEntrySizeBytes',
    async (key) => {
      const huge = '€'.repeat(30_000)
      const err = Object.assign(new Error(huge), { name: `Err${huge}` })

      const written = await entry((logger) => logger.error(err), { errorFormat: 'both' })

      const value = String(written[key])
      expect(Buffer.byteLength(value, 'utf-8')).toBeLessThanOrEqual(CEILING)
      expect(value.endsWith('…[truncated]')).toBe(true)
    }
  )

  it('leaves a short error as it is', async () => {
    const written = await entry((logger) => logger.error(new Error('short')), {
      errorFormat: 'both'
    })

    expect(written['exception.message']).toBe('short')
  })
})

describe('Logger E2E — a serializer output JSON cannot measure', () => {
  it('is replaced by the truncation envelope when it is over the ceiling', async () => {
    const cyclic: Record<string, unknown> = { payload: 'x'.repeat(5000) }
    cyclic['self'] = cyclic

    const written = await entry((logger) => logger.warn({ event: 'LIB_EVENT', thing: cyclic }), {
      serializers: { thing: (value: unknown) => value }
    })

    expect(written['thing']).toMatchObject({ _truncated: true, _logKey: 'LOGGER_ENTRY_TRUNCATED' })
  })
})
