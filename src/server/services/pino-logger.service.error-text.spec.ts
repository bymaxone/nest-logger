/**
 * Pins that making the text of an entry from an `Error` censors the message without reading the
 * error's own properties more often: a getter on an error is the caller's code, and the read it
 * gets is the one guarded read of the message (an `Error` needs no structural check).
 *
 * Layer: server/services, tests. Reads a disabled Pino instance, so nothing is written.
 */
import pino from 'pino'

import { PinoLoggerService } from './pino-logger.service'

describe('the text of an entry that comes from an Error', () => {
  it('reads the message of an Error once: a real Error needs no structural check', () => {
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

    expect(reads).toBe(1)
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

describe('censorMessageText, the censor of the lines the library writes about a failure', () => {
  it('censors a text under the name message, as the message of an entry is', () => {
    const service = new PinoLoggerService(pino({ enabled: false }), () => ({
      message: '[REDACTED]'
    }))

    expect(service.censorMessageText('has a secret in it')).toBe('[REDACTED]')
  })

  it('leaves a text as it is when nothing redacts the name message', () => {
    const service = new PinoLoggerService(pino({ enabled: false }))

    expect(service.censorMessageText('nothing to hide')).toBe('nothing to hide')
  })

  it('returns a long text as it is on an instance that has no limit', () => {
    const service = new PinoLoggerService(pino({ enabled: false }))
    const long = 'x'.repeat(100_000)

    expect(service.censorMessageText(long)).toBe(long)
  })

  it('answers an empty text when the redaction cannot answer, never the text', () => {
    const service = new PinoLoggerService(pino({ enabled: false }), () => {
      throw new Error('redaction exploded')
    })

    expect(service.censorMessageText('a secret')).toBe('')
  })
})
