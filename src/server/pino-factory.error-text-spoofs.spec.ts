/**
 * Pins that a key that only spells `message` is no exemption: under `err` the serializer censors the
 * `message` of the Error, and a field of the Error that is merely spelled like it (another case, a
 * zero-width character, a look-alike letter) is a field with a value like any other, so it is hidden
 * when `message` is a name to hide. And that a key of another script, spelled with look-alikes of a
 * sensitive name, is hidden at the top, below it and in a flat header array.
 *
 * Layer: server, tests. Driven through the real factory and pino.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SECRET = 'SEC_9f3a'

/** The line written for `{ event, ...payload }` under `extra`. */
function lineOf(
  payload: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): string {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', ...payload })
  return lines[0] ?? ''
}

describe('a field of an Error that only spells message', () => {
  it.each([
    ['Message'],
    ['MESSAGE'],
    ['m​essage'],
    ['mеssage'],
    ['messäge'],
    ['mes-sage'],
    ['﻿message']
  ])('is hidden under %j when message is a name to hide', (key) => {
    const err = Object.assign(new Error('benign'), { [key]: SECRET })

    expect(lineOf({ err }, { redactPaths: ['message'] })).not.toContain(SECRET)
  })

  it.each([['Message'], ['m\u200bessage'], ['m\u0435ssage']])(
    'is hidden under %j in an object under err that is no Error',
    (key) => {
      const err = { message: 'benign', [key]: SECRET }

      expect(lineOf({ err }, { redactPaths: ['message'] })).not.toContain(SECRET)
    }
  )

  it('leaves the message of the Error to the serializer, which censors it', () => {
    const line = lineOf({ err: new Error(SECRET) }, { redactPaths: ['message'] })

    expect(line).not.toContain(SECRET)
  })

  it('keeps a field spelled like message when message is not a name to hide', () => {
    const err = Object.assign(new Error('benign'), { Message: SECRET })

    expect(lineOf({ err })).toContain(SECRET)
  })
})

describe('a spelling of a sensitive name in letters of other scripts', () => {
  it.each([['тօкєн'], ['токєн'], ['токен'], ['токе́н']])(
    'hides a value under %j, at the top and below it',
    (key) => {
      expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
      expect(lineOf({ meta: { nested: { [key]: SECRET } } })).not.toContain(SECRET)
    }
  )

  it('hides the value beside such a name in a raw header array', () => {
    const line = lineOf({
      meta: { rawHeaders: ['тօкєн', SECRET, 'Accept', 'text/html'] }
    })

    expect(line).not.toContain(SECRET)
    expect(line).toContain('text/html')
  })

  it.each([['данные'.repeat(6)], ['я'.repeat(30)]])(
    'keeps a key longer than every name, %j',
    (key) => {
      expect(lineOf({ [key]: SECRET })).toContain(SECRET)
    }
  )
})
