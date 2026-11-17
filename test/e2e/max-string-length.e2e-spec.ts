/**
 * E2E: `maxStringLength` set on the module cuts a long string of an entry that reaches a
 * destination, through a real Nest application, and a value outside its range stops the module at
 * boot.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, `validateOptions`, the redaction walk).
 */
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { ILogDestination } from '@bymax-one/nest-logger'

const LIMIT = 128

/** A sink that keeps every payload it is given. */
class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly payloads: string[] = []

  write(payload: string): void {
    this.payloads.push(payload)
  }
}

describe('Logger E2E — maxStringLength', () => {
  it('cuts a megabyte string to the limit and the marker in the entry a destination gets', async () => {
    const collector = new Collector()
    const app = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-max-string', version: '0.0.0' },
          maxStringLength: LIMIT,
          destinations: [collector]
        })
      ]
    }).compile()
    await app.init()

    app.get(PinoLoggerService).info('BIG_PAYLOAD', 'one megabyte', undefined, {
      big: 'x'.repeat(1_000_000)
    })
    await app.close()

    const entry = JSON.parse(
      collector.payloads.find((line) => line.includes('BIG_PAYLOAD')) ?? '{}'
    ) as { big: string }
    expect(entry.big).toBe('x'.repeat(LIMIT) + '…[truncated]')
    expect(collector.payloads.join('').length).toBeLessThan(10_000)
  })

  it('refuses a limit below the smallest at boot, naming the option', () => {
    expect(() =>
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-max-string', version: '0.0.0' },
        maxStringLength: 10
      })
    ).toThrow(/options\.maxStringLength must be an integer from 64 to 2147483647/)
  })
})
