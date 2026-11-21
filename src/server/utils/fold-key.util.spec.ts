/**
 * Pins the rule that decides whether two keys are spellings of one name: the case and the separators
 * `_`, `.` and `-` are folded, and nothing else is, so a different name is never taken for another.
 *
 * Layer: server/utils, tests. Pure.
 */
import { foldedNames, foldKey, foldName } from './fold-key.util'

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
    ['trace:id', 'traceId'],
    ['levels', 'level']
  ])('does not take %s for a spelling of %s', (key, other) => {
    expect(foldKey(key)).not.toBe(foldKey(other))
  })

  it('keeps a digit, so it still tells names apart', () => {
    expect(foldKey('a1b')).toBe('a1b')
  })

  it.each([
    ['trace id', 'traceid'],
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
