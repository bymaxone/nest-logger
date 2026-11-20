/**
 * Pins that the `exception.message` and the `exception.stacktrace` derived from the `err` of a record
 * carry the message as the redaction left it: the stack opens with the message of the error, so the
 * censored text is the one written there too, and a message nobody censored changes nothing.
 *
 * Layer: server/utils, tests. Pure.
 */
import { withSemconvException } from './semconv-exception.util'

const STACK = 'Error: secret\n    at run (/srv/app.js:1:1)'
const censor = (text: string): string => (text === 'secret' ? '[REDACTED]' : text)

const derive = (err: object, censorMessage?: (text: string) => string): Record<string, unknown> =>
  withSemconvException({ err }, 'both', Number.POSITIVE_INFINITY, undefined, censorMessage)

describe('the message in the derived exception fields', () => {
  it('writes the censored message, and opens the stacktrace with it', () => {
    const out = derive({ name: 'Error', message: 'secret', stack: STACK }, censor)

    expect(out['exception.message']).toBe('[REDACTED]')
    expect(out['exception.stacktrace']).toMatch(/^Error: \[REDACTED\]\n/)
    expect(String(out['exception.stacktrace'])).not.toContain('secret')
  })

  it('writes a name that is text as the censor leaves it, in both type fields and the stacktrace', () => {
    const out = derive(
      {
        name: 'N_user=U token=S',
        message: 'm',
        stack: 'N_user=U token=S: m\n    at a (/srv/a.js:1:1)'
      },
      (text) => (text.includes('token=S') ? '[REDACTED]' : text)
    )

    expect(out['exception.type']).toBe('[REDACTED]')
    expect(out['error.type']).toBe('[REDACTED]')
    expect(out['exception.stacktrace']).toMatch(/^\[REDACTED\]: m\n/)
    const { err: _input, ...derived } = out
    expect(JSON.stringify(derived)).not.toContain('token=S')
  })

  it('keeps the name of a class in both type fields', () => {
    const out = derive(
      { name: 'TypeError', message: 'm', stack: 'TypeError: m\n    at a (/a.js:1:1)' },
      censor
    )

    expect(out['exception.type']).toBe('TypeError')
    expect(out['error.type']).toBe('TypeError')
  })

  it('writes the message as it is when nothing censors it', () => {
    const out = derive(
      { name: 'Error', message: 'kept', stack: 'Error: kept\n    at a (/srv/a.js:1:1)' },
      censor
    )

    expect(out['exception.message']).toBe('kept')
    expect(out['exception.stacktrace']).toMatch(/^Error: kept\n/)
  })

  it('writes the message as it is when no censor is given', () => {
    const out = derive({ name: 'Error', message: 'secret', stack: STACK })

    expect(out['exception.message']).toBe('secret')
    expect(out['exception.stacktrace']).toMatch(/^Error: secret\n/)
  })

  it('leaves the stacktrace alone when the error has no message to censor', () => {
    const out = derive({ name: 'Error', stack: STACK }, censor)

    expect(out).not.toHaveProperty('exception.message')
    expect(out['exception.stacktrace']).toMatch(/^Error: secret\n/)
  })

  it('reads the message of the error once, as a getter of the caller is its code', () => {
    let reads = 0
    const err = { name: 'Error', stack: STACK }
    Object.defineProperty(err, 'message', {
      enumerable: false,
      get(): string {
        reads += 1
        return 'secret'
      }
    })

    const out = derive(err, censor)

    expect(reads).toBe(1)
    expect(out['exception.message']).toBe('[REDACTED]')
  })

  it('writes no stacktrace for an error that has none', () => {
    const out = derive({ name: 'Error', message: 'secret' }, censor)

    expect(out['exception.message']).toBe('[REDACTED]')
    expect(out).not.toHaveProperty('exception.stacktrace')
  })
})
