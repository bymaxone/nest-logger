/**
 * Pins how the error Node itself throws for a failed child process is written: with its message and
 * status, and its output (Buffers in own fields) as a size, never as bytes. Needs a real process,
 * so it runs here and not in the unit suite.
 *
 * Layer: end-to-end tests (boots the module through `@nestjs/testing`).
 */
import { execFileSync } from 'node:child_process'

import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

describe.each(['all', 'safe'] as const)(
  'Logger E2E — a failed child process, errorOwnFields %s',
  (mode) => {
    it('is written with its status and its output as a size', async () => {
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
      const moduleRef = await Test.createTestingModule({
        imports: [
          BymaxLoggerModule.forRoot({
            service: { name: 'e2e-child', version: '0.0.0' },
            errorOwnFields: mode
          })
        ]
      }).compile()
      const app = moduleRef.createNestApplication({ logger: false })
      await app.init()
      let thrown: unknown
      try {
        execFileSync(process.execPath, ['-e', 'process.stderr.write("E");process.exit(3)'], {
          stdio: 'pipe'
        })
      } catch (error) {
        thrown = error
      }

      app.get(PinoLoggerService).info('CHILD_FAILED', 'hello', 'u1', { nested: thrown })
      const entry = parseLogEntries(stdoutSpy).find((e) => e['logKey'] === 'CHILD_FAILED')
      stdoutSpy.mockRestore()
      await app.close()

      const nested = entry?.['nested'] as Record<string, unknown>
      expect(nested['message']).toContain('Command failed')
      expect(nested['status']).toBe(3)
      expect(nested['stderr']).toBe(mode === 'all' ? '[Binary 1 bytes]' : undefined)
    })
  }
)
