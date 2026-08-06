jest.mock('node:module', () => {
  const actual = jest.requireActual<typeof import('node:module')>('node:module')
  return { ...actual, createRequire: jest.fn(actual.createRequire) }
})

import { createRequire } from 'node:module'

import { detectOtelTraceApi, isValidSpanId, isValidTraceId } from './otel-detector'

const mockedCreateRequire = jest.mocked(createRequire)

describe('detectOtelTraceApi', () => {
  it(/*
   * When @opentelemetry/api is installed (it is, as a dev dependency), the
   * detector must resolve and return its `trace` namespace.
   */
  'returns the trace API when the module resolves', () => {
    const requireSpy = jest.fn(
      jest.requireActual<typeof import('node:module')>('node:module').createRequire(__filename)
    )
    mockedCreateRequire.mockReturnValueOnce(requireSpy as unknown as NodeJS.Require)

    const api = detectOtelTraceApi()

    expect(api).toBeDefined()
    expect(typeof api?.getActiveSpan).toBe('function')
    // …and it resolves THAT module. `createRequire` is mocked here, so the resolver ignores what
    // it is handed and the specifier itself was pinned by nothing: rename it and the detector
    // still "works" in this suite while every deployment silently loses its trace correlation,
    // because a failed resolve is swallowed by design.
    expect(requireSpy).toHaveBeenCalledWith('@opentelemetry/api')
  })

  it(/*
   * Resolution failure must be swallowed and reported as undefined so a missing
   * optional peer dependency never crashes the host app.
   */
  'returns undefined when resolution throws', () => {
    mockedCreateRequire.mockImplementationOnce(() => {
      throw new Error('Cannot find module @opentelemetry/api')
    })
    expect(detectOtelTraceApi()).toBeUndefined()
  })
})

describe('isValidTraceId', () => {
  it(/*
   * A real 32-hex-char trace ID must be accepted.
   */
  'accepts a valid 32-char trace ID', () => {
    expect(isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true)
  })

  it(/*
   * The all-zeros sentinel (no active trace) must be rejected so it never gets
   * injected into logs.
   */
  'rejects the all-zeros sentinel', () => {
    expect(isValidTraceId('00000000000000000000000000000000')).toBe(false)
  })

  it(/*
   * Empty input must be rejected (wrong length).
   */
  'rejects an empty string', () => {
    expect(isValidTraceId('')).toBe(false)
  })

  it(/*
   * Too-short IDs must be rejected.
   */
  'rejects a too-short id', () => {
    expect(isValidTraceId('toosmall')).toBe(false)
  })

  it(/*
   * Too-long IDs must be rejected (length is exact, not minimum).
   */
  'rejects a too-long id', () => {
    expect(isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736toolong')).toBe(false)
  })

  it(/*
   * A 32-char but non-hex value must be rejected — guards against log-injection
   * payloads smuggled through a malformed trace ID.
   */
  'rejects a 32-char non-hex id', () => {
    expect(isValidTraceId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false)
  })

  it(/*
   * A valid 32-hex id with a non-hex PREFIX must be rejected — pins the leading
   * `^` anchor so a 32-hex substring at the end can't sneak through.
   */
  'rejects a valid hex run preceded by non-hex characters', () => {
    expect(isValidTraceId('zz4bf92f3577b34da6a3ce929d0e0e4736')).toBe(false)
  })

  it(/*
   * A valid (non-all-zero) id that merely STARTS and ENDS with a zero must be
   * accepted — pins both anchors of the all-zeros `/^0+$/` reject so a partial
   * (prefix/suffix) zero match cannot reject a legitimate id.
   */
  'accepts a valid id that is bordered by zeros', () => {
    expect(isValidTraceId('0bf92f3577b34da6a3ce929d0e0e4730')).toBe(true)
  })
})

describe('isValidSpanId', () => {
  it(/*
   * A real 16-hex-char span ID must be accepted.
   */
  'accepts a valid 16-char span ID', () => {
    expect(isValidSpanId('00f067aa0ba902b7')).toBe(true)
  })

  it(/*
   * The all-zeros sentinel must be rejected.
   */
  'rejects the all-zeros sentinel', () => {
    expect(isValidSpanId('0000000000000000')).toBe(false)
  })

  it(/*
   * Wrong-length span IDs must be rejected (32 chars is a trace ID, not a span).
   */
  'rejects a wrong-length id', () => {
    expect(isValidSpanId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(false)
  })

  it(/*
   * Non-hex span IDs must be rejected.
   */
  'rejects a non-hex id', () => {
    expect(isValidSpanId('zzzzzzzzzzzzzzzz')).toBe(false)
  })

  it(/*
   * A valid (non-all-zero) span id that ENDS in a zero must be accepted — pins
   * the leading anchor of the all-zeros `/^0+$/` reject so a trailing-zero match
   * cannot reject a legitimate span.
   */
  'accepts a valid span id ending in zero', () => {
    expect(isValidSpanId('00f067aa0ba90230')).toBe(true)
  })
})
