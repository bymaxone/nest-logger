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
   * optional peer dependency never crashes the host app. BOTH anchors have to
   * fail — the detector tries its own module location and then the working
   * directory — so the mock throws for every call rather than once.
   */
  'returns undefined when every anchor fails to resolve', () => {
    mockedCreateRequire.mockImplementation(() => {
      throw new Error('Cannot find module @opentelemetry/api')
    })
    expect(detectOtelTraceApi()).toBeUndefined()
  })

  it(/*
   * REGRESSION — resolution used to be anchored at `process.cwd()` alone, and
   * that silently disabled ALL trace correlation whenever the working directory
   * was not the application root: a Docker `WORKDIR`, a pnpm/Yarn workspace with
   * hoisted `node_modules`, a monorepo started from the repo root, a serverless
   * bundle. No error, no warning — `traceId` just stopped appearing, precisely
   * where distributed tracing was most likely to be configured.
   *
   * The FIRST anchor must be this module's own path, which is how Node
   * resolution is defined and what every other dependency in the process uses.
   */
  'anchors resolution at its own module path before the working directory', () => {
    const anchors: string[] = []
    mockedCreateRequire.mockImplementation((from) => {
      anchors.push(String(from))
      throw new Error('Cannot find module @opentelemetry/api')
    })

    detectOtelTraceApi()

    // The detector's OWN file, not the spec's and not the working directory.
    expect(anchors[0]).toMatch(/otel-detector\.ts$/)
    expect(anchors[0]).not.toContain('noop.cjs')
  })

  it(/*
   * The working directory remains the SECOND anchor, deliberately: in a bundled
   * application this module's path is the bundle's, which may sit outside any
   * `node_modules` tree, and there the working directory is the better guess.
   */
  'falls back to the working directory when the module anchor fails', () => {
    const anchors: string[] = []
    mockedCreateRequire.mockImplementation((from) => {
      anchors.push(String(from))
      throw new Error('Cannot find module @opentelemetry/api')
    })

    detectOtelTraceApi()

    expect(anchors).toHaveLength(2)
    expect(anchors[1]).toContain('noop.cjs')
    expect(anchors[1]).toContain(process.cwd())
  })

  it(/*
   * The behaviour the regression is really about: with a working directory that
   * has no `node_modules` anywhere above it, detection must STILL succeed,
   * because the module anchor does not care where the process was launched.
   */
  'still resolves under a working directory that cannot reach node_modules', () => {
    // Real resolver, so the assertion is about anchoring rather than about the mock.
    mockedCreateRequire.mockImplementation(
      jest.requireActual<typeof import('node:module')>('node:module').createRequire
    )
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/')

    const api = detectOtelTraceApi()

    expect(api).toBeDefined()
    expect(typeof api?.getActiveSpan).toBe('function')
    cwdSpy.mockRestore()
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
