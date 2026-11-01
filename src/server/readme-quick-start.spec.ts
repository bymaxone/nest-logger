import { Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { BymaxLoggerModule, InjectLogger, PinoLoggerService } from './index'

/** The README's `PaymentsService`, with `this.stripe` (left undefined in the README) stubbed. */
@Injectable()
class PaymentsService {
  readonly stripe = {
    refunds: { create: (): Promise<{ id: string }> => Promise.resolve({ id: 're_abc' }) }
  }

  constructor(
    @InjectLogger(PaymentsService.name)
    private readonly logger: PinoLoggerService
  ) {}

  async refund(paymentId: string, amount: number, requestedBy: string): Promise<void> {
    this.logger.info('PAYMENT_REFUND_REQUESTED', 'Refund requested', requestedBy, {
      paymentId,
      amount
    })
    const result = await this.stripe.refunds.create()
    this.logger.info('PAYMENT_REFUND_SUCCESS', 'Refund processed', requestedBy, {
      paymentId,
      stripeRefundId: result.id
    })
  }
}

/** README "2. Register the module", options copied as written. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'my-app', version: '1.0.0' },
      level: 'info',
      http: { isEnabled: true }
    })
  ],
  providers: [PaymentsService]
})
class AppModule {}

describe('README Quick Start (sections 2 and 4)', () => {
  it(/*
   * Scenario: guards README "Quick Start > 2. Register the module" and "4. Inject the
   * logger in a service". It executes that flow as written (same forRoot options, same
   * @InjectLogger and logger.info calls) and captures stdout, because check:published only
   * type-checks the snippets and cannot see a wrong argument shape or a value that fails
   * validation. It asserts the outcome the README states: one JSON line per call on stdout
   * with level, ISO time, the configured service, logKey, msg, the injected context, the
   * metadata, and the userId passed as the third argument. When the README's snippet or its
   * "Output (JSON, production)" block changes, this test changes with it.
   */
  'logs the README flow as structured JSON lines on stdout', async () => {
    const lines: string[] = []
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await ref.init()
    await ref.get(PaymentsService).refund('pi_xyz', 100, 'u_1')
    await ref.close()

    const entries = lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const success = entries.find((e) => e['logKey'] === 'PAYMENT_REFUND_SUCCESS')

    expect(entries.map((e) => e['logKey'])).toEqual([
      'LOGGER_BOOTSTRAP_OK',
      'PAYMENT_REFUND_REQUESTED',
      'PAYMENT_REFUND_SUCCESS',
      'LOGGER_SHUTDOWN_OK'
    ])
    expect(success).toMatchObject({
      level: 'info',
      service: { name: 'my-app', version: '1.0.0' },
      logKey: 'PAYMENT_REFUND_SUCCESS',
      msg: 'Refund processed',
      context: 'PaymentsService',
      userId: 'u_1',
      paymentId: 'pi_xyz',
      stripeRefundId: 're_abc'
    })
    expect(new Date(String(success?.['time'])).toISOString()).toBe(success?.['time'])
  })
})
