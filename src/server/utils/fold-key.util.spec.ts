/**
 * Pins the rule that decides whether two keys are spellings of one name: the case and the separators
 * `_`, `.` and `-` are folded, and nothing else is, so a different name is never taken for another.
 *
 * Layer: server/utils, tests. Pure.
 */
import { foldedNames, foldKey, foldName, matchesFolded, matchesKey } from './fold-key.util'

describe('foldKey', () => {
  it.each([
    ['traceId', 'traceid'],
    ['trace_id', 'traceid'],
    ['trace.id', 'traceid'],
    ['Trace-Id', 'traceid'],
    ['TRACE_ID', 'traceid'],
    ['request.id', 'requestid'],
    ['a._-b', 'ab'],
    ['', ''],
    ['___', '']
  ])('folds %s to %s', (key, folded) => {
    expect(foldKey(key)).toBe(folded)
  })

  it.each([
    ['trace_ids', 'traceId'],
    ['traceIdx', 'traceId'],
    ['my_trace', 'traceId'],
    ['levels', 'level']
  ])('does not take %s for a spelling of %s', (key, other) => {
    expect(foldKey(key)).not.toBe(foldKey(other))
  })

  it('keeps a digit, so it still tells names apart', () => {
    expect(foldKey('a1b')).toBe('a1b')
  })

  it.each([
    ['trace id', 'traceid'],
    ['trace:id', 'traceid'],
    ['trace/id', 'traceid'],
    ['trace\u2011id', 'traceid'],
    ['trace\u2010id', 'traceid'],
    ['trace\u2212id', 'traceid'],
    ['trace\u2013id', 'traceid'],
    ['trace#id', 'traceid'],
    ['trace\tid', 'traceid'],
    ['req\nuestId', 'requestid'],
    ['trace\u200bid', 'traceid'],
    ['trace\u00adid', 'traceid'],
    ['\ufefftraceId', 'traceid'],
    ['\uff32equestId', 'requestid'],
    ['\u017fpan_id', 'spanid'],
    ['TRACE\u0130D', 'traceid'],
    ['r\u0435questId', 'requestid'],
    ['tr\u0430ce_id', 'traceid'],
    ['\u03bfrder', 'order'],
    ['service_name', 'servicename'],
    ['trace\u0301id', 'traceid'],
    ['tra\u0300ce_id', 'traceid'],
    ['tr\u0000ace_id', 'traceid'],
    ['TRACE\u0131D', 'traceid'],
    ['\u1d1b\u0280\u1d00\u1d04\u1d07_\u026a\u1d05', 'traceid'],
    ['trac\u03b5Id', 'traceid'],
    ['trac\u03f5Id', 'traceid'],
    ['r\u00e9questId', 'requestid'],
    ['trace\u0085id', 'traceid'],
    ['trace\u2028id', 'traceid'],
    ['trace\u2029id', 'traceid'],
    ['trace\u034fid', 'traceid'],
    ['trace\ufe0fid', 'traceid'],
    ['trace\u3164id', 'traceid'],
    ['trace\u115fid', 'traceid'],
    ['trace\u1160id', 'traceid'],
    ['trace\uffa0id', 'traceid'],
    ['trace\u2800id', 'traceid']
  ])('reads %j as the spelling of a name: %s', (key, folded) => {
    expect(foldKey(key)).toBe(folded)
  })

  it.each([
    ['exception\u2800.type', 'exception.type'],
    ['exception.\u3164type', 'exception.type'],
    ['exception.\u115ftype', 'exception.type'],
    ['EXCEPTION.\u0085TYPE', 'exception.type'],
    ['exception\u3002type', 'exception.type'],
    ['exception\u00b7type', 'exception.type'],
    ['exception\u22c5type', 'exception.type'],
    ['exception\u06d4type', 'exception.type'],
    ['exception\u0701type', 'exception.type'],
    ['exception\ufe12type', 'exception.type'],
    ['exception.t\u04afpe', 'exception.type'],
    ['error.typ\u025b', 'error.type'],
    ['error.typ\u04bd', 'error.type'],
    ['\u0269nfo', 'info'],
    ['\u00f8rder', 'order'],
    ['\u0167race', 'trace'],
    ['\u023cache', 'cache'],
    ['\u0188ache', 'cache'],
    ['\u01bfath', 'path']
  ])('keeps the separators and reads %j as %s', (key, folded) => {
    expect(foldKey(key, true)).toBe(folded)
  })

  it('does not take a different name for another because of a character it folds', () => {
    expect(foldKey('trace\u200bids')).not.toBe(foldKey('traceId'))
    expect(foldKey('r\u0435questIds')).not.toBe(foldKey('requestId'))
  })
})

describe('foldName', () => {
  it.each([
    ['apikey', 'apikey'],
    ['apiKey', 'apikey'],
    ['API2Key', 'api2key'],
    ['api_key', 'apikey'],
    ['api-Key', 'apikey'],
    ['api.Key', 'apikey'],
    ['api\u200bKey', 'apikey'],
    ['\u0430pi_Key ', 'apikey'],
    ['\uff41piKey', 'apikey'],
    ['', ''],
    ['\u200b', '']
  ])('reads %j as %j', (key, folded) => {
    expect(foldName(key)).toBe(folded)
  })

  it('folds a key of any length, the same on each call', () => {
    const long = `${'a_'.repeat(200_000)}Z`

    expect(foldName(long)).toBe(`${'a'.repeat(200_000)}z`)
    expect(foldName(long)).toBe(`${'a'.repeat(200_000)}z`)
  })
})

describe('foldedNames', () => {
  it('folds each name and leaves out one that folds to nothing', () => {
    expect(foldedNames(['apiKey', 'x-auth-token', '\u200b', ' ', 'PASSWORD'])).toEqual(
      new Set(['apikey', 'xauthtoken', 'password'])
    )
  })

  it('takes any iterable', () => {
    expect(foldedNames(new Set(['A_b']))).toEqual(new Set(['ab']))
  })
})

describe('matchesFolded', () => {
  const names = new Set(['authorization', 'password', 'xapikey'])

  it('looks an ASCII key up as it is', () => {
    expect(matchesFolded(names, 'password')).toBe(true)
    expect(matchesFolded(names, 'passwords')).toBe(false)
    expect(matchesFolded(names, 'author')).toBe(false)
  })

  it.each([
    ['aut\u04bborization', true],
    ['\u04bbassword', true],
    ['passw\u0251rd', true],
    ['pa\u057d\u057dword', true],
    ['\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb', true],
    ['\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb', true],
    ['\u04bb'.repeat(30), false],
    ['pas\u04bb\u04bb\u04bb\u04bb\u04bb', true],
    ['pa\u04bb\u04bb\u04bb\u04bb\u04bb\u04bb', true],
    ['\u7528\u6237\u540d', false],
    ['\u540d\u524d', false],
    ['\u04bbassword1', false],
    ['aut\u04bborizatio', false],
    ['x\u04bbpikey', true],
    ['\u04bbpikey', true],
    ['aut\u04bborizatioz', false],
    ['\u04bbassw0rd', false]
  ])('reads %j, with a letter that is not ASCII standing for any one, as %s', (key, expected) => {
    expect(matchesFolded(names, key)).toBe(expected)
  })

  it('counts a letter outside the basic plane as one character', () => {
    expect(matchesFolded(names, 'pass\u{1d5ee}ord')).toBe(true)
    expect(matchesFolded(new Set(['abc']), 'a\u{1d5ee}c')).toBe(true)
    expect(matchesFolded(new Set(['abcd']), 'a\u{1d5ee}c')).toBe(false)
  })

  it('matches a name that holds a letter that is not ASCII, as it is', () => {
    const russian = new Set(['\u043f\u0430\u0440\u043e\u043b\u044c'])

    expect(matchesFolded(russian, '\u043f\u0430\u0440\u043e\u043b\u044c')).toBe(true)
    expect(matchesFolded(russian, '\u043f\u0430\u0440\u043e\u043b')).toBe(true)
    expect(matchesFolded(russian, '\u043f\u0430\u0440\u043e\u043b'.repeat(3))).toBe(false)
    expect(matchesFolded(new Set(['abc']), '\u04bb'.repeat(7))).toBe(false)
  })

  /**
   * Given a key with no ASCII letter at all, such as a word of another script that a name can be spelled
   * with look-alikes of
   * When it is not longer than the longest name
   * Then it is read as a pattern and hidden, and a key longer than every name is not: a leak is worse
   * than hiding a short field of another script
   */
  it('hides a key of another script that is no longer than the longest name, and no other', () => {
    const owned = new Set(['msg', 'time', 'level'])

    for (const key of [
      '\u7528\u6237\u540d',
      '\u540d\u524d\u3067\u3059',
      '\u0434\u0430\u043d',
      '\u05e9\u05dd'
    ]) {
      expect(matchesFolded(owned, key)).toBe(true)
    }
    expect(matchesFolded(owned, '\u0434\u0430\u043d\u043d\u044b\u0435')).toBe(false)
    expect(matchesFolded(owned, '\u044f'.repeat(24))).toBe(false)
  })

  it.each([
    '\u0442\u0585\u043a\u0454\u043d',
    '\u0442\u043e\u043a\u0454\u043d',
    '\u0442\u043e\u043a\u0435\u043d'
  ])('hides %j, a spelling of token with no Latin letter in it', (key) => {
    expect(matchesFolded(new Set(['password', 'token']), key)).toBe(true)
  })

  it('answers the same for a set it has met and for one it has not', () => {
    const another = new Set(['token'])

    expect(matchesFolded(another, 'to\u0138en')).toBe(true)
    expect(matchesFolded(another, 'to\u0138en')).toBe(true)
    expect(matchesFolded(names, 'to\u0138en')).toBe(false)
  })

  it.each([
    ['\u00feassword', true],
    ['thassword', false],
    ['\u00dfearer', true],
    ['\u00dfsearer', false],
    ['pa\u00dfword', true],
    ['au\u00feorization', true],
    ['auth\u00feorization', false],
    ['\u00fe\u00fe\u00fe\u00fe\u00fe\u00fe\u00fe\u00fe', true],
    ['\u00fe'.repeat(30), false]
  ])('reads %j, a letter of one or of two, as %s of a name', (key, expected) => {
    expect(matchesFolded(new Set(['password', 'bearer', 'authorization']), key)).toBe(expected)
  })

  it.each([
    ['\u7528\u6237\u540d', true],
    ['\u540d\u524d\u3067\u3059', true],
    ['user\u7528\u6237', true],
    ['m\u6d88\u606f', true],
    ['\u0442oken', true],
    ['to\u0138en', true],
    ['\u056a'.repeat(8), false]
  ])('reads %j, whatever the script of its letters, as %s', (key, expected) => {
    expect(matchesFolded(new Set(['userid', 'msg', 'id', 'time', 'token']), key)).toBe(expected)
  })

  it('does not read Greek small nu as v, which would defeat a capital nu', () => {
    expect(foldKey('toke\u039d')).toBe('toke\u03bd')
    expect(matchesFolded(new Set(['token']), foldKey('TOKE\u039d'))).toBe(true)
  })
})

describe('matchesFolded, the work for one key', () => {
  it('rejects a key longer than the longest name without walking', () => {
    expect(matchesFolded(new Set(['token']), `tok\u04bbn${'x'.repeat(50)}`)).toBe(false)
  })

  it('hides a key that has more candidate names than the bound', () => {
    const many = new Set(
      Array.from({ length: 100 }, (_, i) => `field${String(i).padStart(3, '0')}`)
    )

    expect(matchesFolded(many, 'f\u04bbeld123')).toBe(true)
    expect(matchesFolded(many, 'f\u04bbeld1234')).toBe(false)
  })

  it.each([
    [64, false],
    [65, true]
  ])(
    'walks a key against %i candidate names and hides it only past the bound: %s',
    (count, hidden) => {
      const names = new Set(
        Array.from({ length: count }, (_, i) => `field${String(i).padStart(3, '0')}`)
      )

      expect(matchesFolded(names, 'f\u04bbeld999')).toBe(hidden)
    }
  )

  it('groups a large set of names in a time that is linear in them', () => {
    const large = new Set(
      Array.from({ length: 40_000 }, (_, i) => `field${String(i).padStart(6, '0')}`)
    )
    const started = Date.now()

    const hidden = matchesFolded(large, 'f\u04bbeld123456')

    expect(hidden).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('walks a key against a few candidates and tells them apart', () => {
    const few = new Set(['token', 'tokens', 'toke'])

    expect(matchesFolded(few, 'to\u04bben')).toBe(true)
    expect(matchesFolded(few, 'to\u04bbex')).toBe(false)
  })
})

describe('matchesKey remembers what a set answered', () => {
  const names = foldedNames(['apiKey'])

  /**
   * Given a set that has answered more keys than it remembers
   * When it is asked about a key it has not seen, and about the ones it has
   * Then every answer is the one the fold gives, and a second set does not share them
   */
  it('still answers a new key correctly once it has been filled, and keeps each set apart', () => {
    for (let index = 0; index < 3000; index += 1) {
      expect(matchesKey(names, `field${String(index)}`)).toBe(false)
    }
    expect(matchesKey(names, 'API_KEY')).toBe(true)
    expect(matchesKey(names, 'API_KEY')).toBe(true)
    expect(matchesKey(names, 'api​Key')).toBe(true)
    expect(matchesKey(names, 'field7')).toBe(false)
    expect(matchesKey(foldedNames(['field7']), 'field7')).toBe(true)
    expect(matchesKey(names, 'field7')).toBe(false)
  })

  /**
   * Given a key longer than what is remembered
   * When it is asked twice
   * Then both answers are right
   */
  it('answers a long key without remembering it', () => {
    const long = `${'a'.repeat(100)}Key`
    expect(matchesKey(foldedNames([long]), long)).toBe(true)
    expect(matchesKey(names, long)).toBe(false)
    expect(matchesKey(names, long)).toBe(false)
  })
})

/** A set that counts how often it is asked, so a test can tell an answer that was remembered. */
class CountingSet extends Set<string> {
  asked = 0

  override has(value: string): boolean {
    this.asked += 1
    return super.has(value)
  }
}

describe('matchesKey, what it remembers', () => {
  /** How often one more question about the key reaches the set. */
  const cost = (names: CountingSet, key: string): number => {
    const before = names.asked
    matchesKey(names, key)
    return names.asked - before
  }

  /**
   * Given a key of 64 characters and one of 65
   * When each is put to the set twice
   * Then the first is remembered and the second is not
   */
  it('remembers a key of 64 characters and not one of 65', () => {
    const names = new CountingSet(['apikey'])

    matchesKey(names, 'a'.repeat(64))
    matchesKey(names, 'a'.repeat(65))

    expect(cost(names, 'a'.repeat(64))).toBe(0)
    expect(cost(names, 'a'.repeat(65))).toBeGreaterThan(0)
  })

  /**
   * Given a set that has answered 1,024 keys
   * When a 1,025th is put to it
   * Then the first 1,024 were all remembered, and the set then starts over
   */
  it('holds 1,024 answers and starts over at the next', () => {
    const names = new CountingSet(['apikey'])
    for (let index = 0; index < 1024; index += 1) matchesKey(names, `field${String(index)}`)

    expect(cost(names, 'field0')).toBe(0)
    expect(cost(names, 'field1023')).toBe(0)
    matchesKey(names, 'one-more')
    expect(cost(names, 'field1')).toBeGreaterThan(0)
  })

  /**
   * Given a set that has answered a key
   * When it is built once and asked for the groups of two keys
   * Then the names are walked once, not once a key
   */
  it('groups the names of a set once', () => {
    let walks = 0
    const names = new Set(['clientsecret'])
    names[Symbol.iterator] = function* (this: Set<string>) {
      walks += 1
      yield* Set.prototype.values.call(this)
    } as never

    matchesFolded(names, 'cl用ntsecret')
    matchesFolded(names, 'cli用ntsecret')

    expect(walks).toBe(1)
  })
})

describe('matchesFolded, what it counts', () => {
  /**
   * Given more than the bound of names of the key's length and a key that is only ASCII
   * When the key is not one of them
   * Then it is not hidden
   */
  it('does not hide an ASCII key because the names of its length are many', () => {
    const names = new Set(Array.from({ length: 65 }, (_, index) => `n${String(1000 + index)}`))

    expect(matchesFolded(names, 'abcde')).toBe(false)
  })

  /**
   * Given many names that are longer than any length a key can stand for
   * When a key with one letter of another script is put to them
   * Then they are not counted
   */
  it('counts only the lengths the letters of another script can stand for', () => {
    const names = new Set(Array.from({ length: 65 }, (_, index) => `n${String(100000 + index)}`))
    names.add('abcdefgh')

    expect(matchesFolded(names, 'abc字')).toBe(false)
  })

  /**
   * Given a name and a key whose last character is a C1 control character
   * When the key is put to the name
   * Then that character is a letter of another script, not an ASCII one
   */
  it('takes the first character past DEL for a letter of another script', () => {
    expect(matchesFolded(new Set(['abc']), 'ab\u0080')).toBe(true)
  })

  /**
   * Given a name and a key whose last character is DEL
   * When the key is put to the name
   * Then DEL is an ASCII character, so it is itself and no name's letter
   */
  it('takes DEL for an ASCII character', () => {
    expect(matchesFolded(new Set(['abc']), 'ab\u007f')).toBe(false)
  })
})
