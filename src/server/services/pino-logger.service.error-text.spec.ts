/**
 * Pins that making the text of an entry from an `Error` censors the message without reading the
 * error's own properties more often: a getter on an error is the caller's code, and the reads it
 * gets are the structural check of an error and the one guarded read of the message.
 *
 * Layer: server/services, tests. Reads a disabled Pino instance, so nothing is written.
 */
import pino from 'pino'

import { PinoLoggerService } from './pino-logger.service'

describe('the text of an entry that comes from an Error', () => {
  it('reads the message of the error twice, the structural check and the guarded read', () => {
    let reads = 0
    const error = new Error('secret')
    Object.defineProperty(error, 'message', {
      enumerable: false,
      get(): string {
        reads += 1
        return 'secret'
      }
    })
    const service = new PinoLoggerService(pino({ enabled: false }), () => ({
      message: '[REDACTED]'
    }))

    service.error(error)

    expect(reads).toBe(2)
  })

  it('writes the censored text as one line, with a control character as its escape', () => {
    const logger = pino({ enabled: false })
    const error = jest.spyOn(logger, 'error')
    const service = new PinoLoggerService(logger, () => ({ message: 'MASK\nFORGED\u001bE' }))

    service.error(new Error('secret'))

    expect(error).toHaveBeenCalledWith(expect.anything(), 'MASK\\nFORGED\\u001bE')
  })

  it('keeps the censored text within the cap of a log message', () => {
    const logger = pino({ enabled: false })
    const error = jest.spyOn(logger, 'error')
    const service = new PinoLoggerService(logger, () => ({ message: 'c'.repeat(20_000) }))

    service.error(new Error('secret'))

    const text = String(error.mock.calls[0]?.[1])
    expect(text).toBe(`${'c'.repeat(16_384)}…[truncated]`)
  })
})
