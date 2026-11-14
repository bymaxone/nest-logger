/**
 * Pins that the log context decorator records its label as class metadata under a stable key.
 * Layer: server/decorators, tests.
 */
import 'reflect-metadata'

import { LOG_CONTEXT_METADATA_KEY, LogContext } from './log-context.decorator'

describe('LogContext', () => {
  /*
   * @LogContext(name) must record the label under the well-known metadata key so
   * a future LoggerContextInterceptor can read it. This is the decorator's whole
   * contract.
   */
  it('applies the context label as class metadata', () => {
    @LogContext('PaymentsService')
    class Target {}

    expect(Reflect.getMetadata(LOG_CONTEXT_METADATA_KEY, Target)).toBe('PaymentsService')
  })

  /*
   * The metadata key is part of the public contract and must remain stable;
   * a rename would silently break context auto-application.
   */
  it('exposes a stable metadata key', () => {
    expect(LOG_CONTEXT_METADATA_KEY).toBe('bymax_logger:log_context')
  })
})
