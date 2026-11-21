/**
 * Pins the rule that decides whether two keys are spellings of one name: the case and the separators
 * `_`, `.` and `-` are folded, and nothing else is, so a different name is never taken for another.
 *
 * Layer: server/utils, tests. Pure.
 */
import { foldKey } from './fold-key.util'

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
    ['r\u00e9questId', 'requestid']
  ])('reads %j as the spelling of a name: %s', (key, folded) => {
    expect(foldKey(key)).toBe(folded)
  })

  it('does not take a different name for another because of a character it folds', () => {
    expect(foldKey('trace\u200bids')).not.toBe(foldKey('traceId'))
    expect(foldKey('r\u0435questIds')).not.toBe(foldKey('requestId'))
  })
})
