import 'reflect-metadata'

import { LOG_CONTEXT_METADATA_KEY, LogContext } from './log-context.decorator'

describe('LogContext', () => {
  it(/*
   * @LogContext(name) must record the label under the well-known metadata key so
   * a future LoggerContextInterceptor can read it. This is the decorator's whole
   * contract.
   */
  'applies the context label as class metadata', () => {
    @LogContext('PaymentsService')
    class Target {}

    expect(Reflect.getMetadata(LOG_CONTEXT_METADATA_KEY, Target)).toBe('PaymentsService')
  })

  it(/*
   * The metadata key is part of the public contract and must remain stable;
   * a rename would silently break context auto-application.
   */
  'exposes a stable metadata key', () => {
    expect(LOG_CONTEXT_METADATA_KEY).toBe('bymax_logger:log_context')
  })
})
