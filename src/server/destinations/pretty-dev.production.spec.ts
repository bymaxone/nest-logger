/**
 * End to end: what an application sees when it registers `PrettyDevDestination` with
 * `NODE_ENV=production`.
 *
 * Layer: server/destinations, tests. The destination refuses at init, and the registry
 * turns that refusal into a stderr report and, when the pretty sink is the only one,
 * a rescue to stdout as raw NDJSON, so the application keeps logging in a form a log
 * pipeline can parse.
 */
import { Test } from '@nestjs/testing'

import { BymaxLoggerModule } from '../logger.module'
import { PinoLoggerService } from '../services/pino-logger.service'

import { PrettyDevDestination } from './pretty-dev.destination'

describe('PrettyDevDestination registered in production', () => {
  const originalNodeEnv = process.env['NODE_ENV']

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV']
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  it(/*
   * As the only destination in production it refuses; the entry is rescued to stdout
   * as parseable JSON with no ANSI escape, and one stderr line names the refusal.
   */
  'rescues entries to stdout as raw JSON and reports the refusal on stderr', async () => {
    process.env['NODE_ENV'] = 'production'
    const stdout: string[] = []
    const stderr: string[] = []
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    })
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })

    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'app', version: '1.0.0' },
          destinations: [new PrettyDevDestination()]
        })
      ]
    }).compile()
    await ref.init()
    ref.get(PinoLoggerService).info('PROBE_RESCUED', 'rescued line')
    await new Promise((resolve) => setImmediate(resolve))
    await ref.close()

    const entries = stdout
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries.some((entry) => entry['logKey'] === 'PROBE_RESCUED')).toBe(true)
    expect(stdout.join('')).not.toContain('\u001b[')
    expect(stderr.join('')).toMatch(/LOGGER_DESTINATION_INIT_FAILED.*refused in production/)
  })
})
