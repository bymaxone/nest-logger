/**
 * Pins the helpers that read the message of an object for the header of its stack, and the name of an
 * error, as the rules of the walk hide them: which object has a header to hide, that the message is
 * read once, which field the header replacement reaches, and which values a name hides with the message.
 *
 * Layer: server/utils, tests. Pure.
 */
import {
  MAX_STACK_ALIASES,
  censorAnyName,
  errorTextField,
  headerMessage,
  readField
} from './error-text-exemption.util'
import type { RedactRules } from './redact-by-name.util'
import { MAX_STACK_SCAN } from './sanitize-error.util'

const SECRET = 'SEC_9f3a'

const rules = (sensitive: string[] = ['message']): RedactRules =>
  ({ sensitive: new Set(sensitive), censor: '[R]' }) as unknown as RedactRules

describe('headerMessage', () => {
  it('reads the message of an object that owns a message and a stack', () => {
    const source = { message: SECRET, stack: 'x' }

    expect(headerMessage(rules(), source, ['message', 'stack'], false)).toEqual({
      overflow: false,
      texts: new Map([['message', SECRET]])
    })
  })

  it('reads no message of an object that owns a stack and inherits its message', () => {
    const source = Object.create({ message: SECRET }) as object
    Object.assign(source, { stack: `Error: ${SECRET}` })

    expect(headerMessage(rules(), source, ['stack'], false)).toEqual({
      overflow: false,
      texts: new Map()
    })
  })

  it('reads nothing of an object that owns a message and no stack', () => {
    const source = { message: SECRET }

    expect(headerMessage(rules(), source, ['message'], false)).toBeUndefined()
  })

  it('reads no message when the options do not hide it, and nothing of an error', () => {
    const source = { message: SECRET, stack: 'x' }

    expect(headerMessage(rules(['token']), source, ['message', 'stack'], false)).toEqual({
      overflow: false,
      texts: new Map()
    })
    expect(headerMessage(rules(), source, ['message', 'stack'], true)).toBeUndefined()
  })
})

describe('headerMessage, the spelling of the keys', () => {
  it.each([
    ['Message', 'Stack'],
    ['MESSAGE', 'stack'],
    ['message', 'STACK'],
    ['M\u200bessage', 'Stack'],
    ['M\u0435ssage', 'St\u0430ck']
  ])('reads %s and %s as the message and the stack', (messageKey, stackKey) => {
    const source = { [messageKey]: SECRET, [stackKey]: 'x' }

    expect(headerMessage(rules(), source, [messageKey, stackKey], false)).toEqual({
      overflow: false,
      texts: new Map([[messageKey, SECRET]])
    })
  })

  it('reads no message when a key is another word', () => {
    const source = { messages: SECRET, stack: 'x' }

    expect(headerMessage(rules(), source, ['messages', 'stack'], false)).toEqual({
      overflow: false,
      texts: new Map()
    })
    expect(headerMessage(rules(), source, ['stack', 'stacks'], false)).toEqual({
      overflow: false,
      texts: new Map()
    })
  })
})

describe('headerMessage, more than one key that spells the name', () => {
  it('reads every key that spells message, each once', () => {
    let reads = 0
    const source = {
      message: 'benign',
      get Message(): string {
        reads += 1
        return SECRET
      },
      stack: 'x'
    }

    const header = headerMessage(rules(), source, ['message', 'Message', 'stack'], false)

    expect(header).toEqual({
      overflow: false,
      texts: new Map([
        ['message', 'benign'],
        ['Message', SECRET]
      ])
    })
    expect(reads).toBe(1)
  })

  it('skips a key that spells message and holds no text', () => {
    const source = { message: 7, Message: SECRET, stack: 'x' }

    expect(headerMessage(rules(), source, ['message', 'Message', 'stack'], false)).toEqual({
      overflow: false,
      texts: new Map([['Message', SECRET]])
    })
  })

  it('reads no message when no key that spells message holds text', () => {
    const source = { message: 7, stack: 'x' }

    expect(headerMessage(rules(), source, ['message', 'stack'], false)).toEqual({
      overflow: false,
      texts: new Map()
    })
  })
})

describe('errorTextField, a header with more than one message', () => {
  it('hides each distinct text in a stack, the longer before the shorter', () => {
    const header = {
      overflow: false,
      texts: new Map([
        ['message', 'ab'],
        ['Message', 'ab cd']
      ])
    }

    expect(errorTextField(rules(), 'Stack', 'Error: ab cd\n    at f (ab)', false, header)).toBe(
      'Error: [R]\n    at f ([R])'
    )
  })
})

describe('readField', () => {
  it('reads a field once when the message was read for the header', () => {
    let reads = 0
    const source = {
      get message(): string {
        reads += 1
        return SECRET
      }
    }
    const message = headerMessage(rules(), source, ['message', 'stack'], false)

    expect(readField(source, 'message', message)).toBe(SECRET)
    expect(reads).toBe(1)
  })

  it('reads any other field, and the message when none was read, from the object', () => {
    const source = { message: 'm', other: 'o' }

    expect(
      readField(source, 'other', { overflow: false, texts: new Map([['message', 'cached']]) })
    ).toBe('o')
    expect(readField(source, 'message', undefined)).toBe('m')
  })
})

describe('errorTextField', () => {
  it('hides the message in the stack of an object that is no error, and in no other field', () => {
    const stack = `Error: ${SECRET}\n    at run (/srv/app.js:1:1)`

    expect(
      errorTextField(rules(), 'stack', stack, false, {
        overflow: false,
        texts: new Map([['message', SECRET]])
      })
    ).toBe('Error: [R]\n    at run (/srv/app.js:1:1)')
    expect(
      errorTextField(rules(), 'note', `see ${SECRET}`, false, {
        overflow: false,
        texts: new Map([['message', SECRET]])
      })
    ).toBe(`see ${SECRET}`)
  })
})

describe('censorAnyName', () => {
  it.each([
    ['an object', { toString: () => SECRET }],
    ['an array', [SECRET]],
    ['a function', () => SECRET]
  ])('hides %s with the message', (_label, name) => {
    expect(censorAnyName(rules(), name)).toBe('[R]')
  })

  it.each([
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true]
  ])('keeps %s', (_label, name) => {
    expect(censorAnyName(rules(), name)).toBe(name)
  })

  it('keeps a value that holds anything when the options do not hide the message', () => {
    const name = { toString: () => SECRET }

    expect(censorAnyName(rules(['token']), name)).toBe(name)
  })
})

describe('the stack of an object that is no Error, read up to the scan bound', () => {
  const FRAME = '\n    at app (/srv/a.js:1:1)'
  const DEP = (text: string): string => `\n    at dep (/node_modules/${text})`

  it('does not read a frame beyond the bound, even when the hidden messages shrink the text before it', () => {
    const message = 'm'.repeat(100)
    const lines = DEP(message).repeat(Math.ceil(MAX_STACK_SCAN / DEP(message).length) + 900)
    const stack = `Error: x${lines}\n    at ZZZ_APP (/srv/z.js:1:1)`
    expect(stack.indexOf('ZZZ_APP')).toBeGreaterThan(MAX_STACK_SCAN)

    const written = errorTextField(rules(), 'stack', stack, false, {
      overflow: false,
      texts: new Map([['message', message]])
    }) as string

    expect(written).not.toContain('ZZZ_APP')
  })

  it.each([
    [0, 'Error: a'],
    [1, 'Error: a…[truncated]']
  ])('adds the suffix only to a stack longer than the bound (%i over)', (over, expected) => {
    const frame = DEP('p/i.js:1:1')
    const fill = MAX_STACK_SCAN + over - 'Error: a'.length
    const stack = `Error: a${frame.repeat(Math.floor(fill / frame.length))}${'x'.repeat(fill % frame.length)}`
    expect(stack.length).toBe(MAX_STACK_SCAN + over)

    expect(
      errorTextField(rules(), 'stack', stack, false, { overflow: false, texts: new Map() })
    ).toBe(expected)
  })

  it('keeps a short clean stack as it was written', () => {
    const stack = `Error: a${FRAME}`

    expect(
      errorTextField(rules(), 'stack', stack, false, { overflow: false, texts: new Map() })
    ).toBe(stack)
  })

  it('does not keep a frame whose offset is past the bound when long messages are hidden before it', () => {
    const message = 'm'.repeat(5_000)
    const lead = `Error: x${DEP(message).repeat(25)}`
    const pad = '\n    at pad'
    const stack = `${lead}${pad.repeat(Math.ceil((MAX_STACK_SCAN + 1_000 - lead.length) / pad.length))}\n    at ZZZ_APP (/srv/z.js:1:1)`
    expect(stack.indexOf('ZZZ_APP')).toBeGreaterThan(MAX_STACK_SCAN)
    expect(stack.indexOf('ZZZ_APP')).toBeLessThan(MAX_STACK_SCAN + message.length)

    const written = errorTextField(rules(), 'stack', stack, false, {
      overflow: false,
      texts: new Map([['message', message]])
    }) as string

    expect(written).not.toContain('ZZZ_APP')
  })

  it('leaves no part of a message that starts before the end of the window and ends after it', () => {
    const message = `LEAKMARK${'q'.repeat(992)}`
    const before = `Error: a${DEP(message)}`
    const padding = `\n    at dep (/node_modules/${'p'.repeat(MAX_STACK_SCAN + 500 - before.length - 30)}`
    const stack = `${before}${padding})\n    at app (/srv/${message}`
    expect(stack.indexOf('LEAKMARK', 100)).toBeGreaterThan(MAX_STACK_SCAN)

    const written = errorTextField(rules(), 'stack', stack, false, {
      overflow: false,
      texts: new Map([['message', message]])
    }) as string

    expect(written).not.toContain('LEAKMARK')
  })
})

describe('headerMessage, an object with more than a search can be bounded for', () => {
  const alias = (index: number): string => `message${'\u200b'.repeat(index)}`
  const source = (messages: number, stacks = 1): Record<string, string> => ({
    ...Object.fromEntries(
      Array.from({ length: messages }, (_, i) => [alias(i), `secret${String(i)}`])
    ),
    ...Object.fromEntries(
      Array.from({ length: stacks }, (_, i) => [`stack${'\u200b'.repeat(i)}`, 'x'])
    )
  })
  const plan = (given: Record<string, string>): { overflow: boolean } | undefined =>
    headerMessage(rules(), given, Object.keys(given), false)

  it('searches for as many distinct messages as the cap', () => {
    expect(plan(source(MAX_STACK_ALIASES))?.overflow).toBe(false)
  })

  it('hides every stack whole for one message more than the cap', () => {
    expect(plan(source(MAX_STACK_ALIASES + 1))?.overflow).toBe(true)
  })

  it('counts distinct messages, so many keys that hold one text are one message', () => {
    const given = Object.fromEntries([
      ...Array.from({ length: 50 }, (_, i) => [alias(i), 'same']),
      ['stack', 'x']
    ]) as Record<string, string>

    expect(plan(given)?.overflow).toBe(false)
  })

  it('searches for as many stack keys as the cap, and hides every stack whole beyond it', () => {
    expect(plan(source(1, MAX_STACK_ALIASES))?.overflow).toBe(false)
    expect(plan(source(1, MAX_STACK_ALIASES + 1))?.overflow).toBe(true)
  })

  it('writes the censor in place of a stack when the plan overflows', () => {
    expect(
      errorTextField(rules(), 'stack', 'Error: x', false, { overflow: true, texts: new Map() })
    ).toBe('[R]')
  })
})
