jest.mock('node:module', () => {
  const actual = jest.requireActual<typeof import('node:module')>('node:module')
  return { ...actual, createRequire: jest.fn(actual.createRequire) }
})

import { createRequire } from 'node:module'

import {
  detectOtelTraceApi,
  isValidSpanId,
  isValidTraceId,
  resetBrokenInstallWarning
} from './otel-detector'

const mockedCreateRequire = jest.mocked(createRequire)

/** The error Node throws when `@opentelemetry/api` itself cannot be resolved. */
const notFound = (): Error =>
  Object.assign(
    new Error("Cannot find module '@opentelemetry/api'\nRequire stack:\n- /app/index.js"),
    { code: 'MODULE_NOT_FOUND' }
  )

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
      throw notFound()
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
      throw notFound()
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
      throw notFound()
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

describe('detectOtelTraceApi — a failure that is not a missing module', () => {
  let stderrSpy: jest.SpyInstance

  beforeEach(() => {
    resetBrokenInstallWarning()
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    mockedCreateRequire.mockReset()
    mockedCreateRequire.mockImplementation(
      jest.requireActual<typeof import('node:module')>('node:module').createRequire
    )
  })

  /** Every stderr line written so far, parsed. */
  const lines = (): Record<string, unknown>[] =>
    stderrSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)

  /** A resolver whose `require` throws `failure` for the optional peer. */
  const requireThrows = (failure: unknown) => (): NodeJS.Require =>
    (() => {
      throw failure
    }) as unknown as NodeJS.Require

  it(/*
   * The designed outcome stays silent: the optional peer is simply not installed, and a
   * logger never warns over an optional peer. Both anchors fail to find it.
   */
  'stays silent when @opentelemetry/api is not installed', () => {
    mockedCreateRequire.mockImplementation(requireThrows(notFound()))

    expect(detectOtelTraceApi()).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a module that throws while loading', () => new SyntaxError('Unexpected token')],
    [
      'a missing module INSIDE @opentelemetry/api',
      () =>
        Object.assign(
          new Error(
            "Cannot find module 'some-dependency'\nRequire stack:\n- /app/node_modules/@opentelemetry/api/index.js"
          ),
          { code: 'MODULE_NOT_FOUND' }
        )
    ],
    [
      'a resolution error that carries no code',
      () => new Error("Cannot find module '@opentelemetry/api'")
    ],
    [
      'a message that names the module only after other text',
      () =>
        Object.assign(
          new Error(
            "Cannot find module 'other'\nCannot find module '@opentelemetry/api' is mentioned later"
          ),
          { code: 'MODULE_NOT_FOUND' }
        )
    ]
  ])('warns once on stderr for %s, and still returns undefined', (_label, makeFailure) => {
    /*
     * REGRESSION — every failure to load the optional peer was swallowed as "not
     * installed", so an installed but broken @opentelemetry/api switched trace correlation
     * off with no sign anywhere: the operator believed it was on and `traceId` was simply
     * absent. Only a failure to find the peer ITSELF is silent; anything else is a broken
     * install and says so once.
     */
    const failure = makeFailure()
    mockedCreateRequire.mockImplementation(requireThrows(failure))

    expect(detectOtelTraceApi()).toBeUndefined()

    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({
      level: 'warn',
      logKey: 'LOGGER_OTEL_API_BROKEN',
      // The report pins the message to one line, escaping the newline.
      err: { type: failure.name, message: failure.message.replaceAll('\n', '\\n') }
    })
    // The line says what to do about it, and is newline-terminated like every stderr record.
    expect(lines()[0]?.['msg']).toBe(
      '@opentelemetry/api is installed but could not be loaded, so traceId and spanId are ' +
        'absent from every entry. Reinstall it, or set otel.shouldAutoInjectTraceContext to false.'
    )
    expect(String(stderrSpy.mock.calls[0]?.[0]).endsWith('\n')).toBe(true)
  })

  it(/*
   * Once per process: the detector runs at the Pino build and again at bootstrap, and a
   * broken install must not repeat itself on every call.
   */
  'writes the broken-install warning only once', () => {
    mockedCreateRequire.mockImplementation(requireThrows(new SyntaxError('Unexpected token')))

    detectOtelTraceApi()
    detectOtelTraceApi()
    detectOtelTraceApi()

    expect(lines()).toHaveLength(1)
  })

  it(/*
   * A module that resolves but exports nothing usable is broken too: reading `trace` off a
   * falsy export throws, and that is a failure of the install, not an absence.
   */
  'warns when the module resolves to a falsy export', () => {
    mockedCreateRequire.mockImplementation(
      (() => () => undefined) as unknown as typeof createRequire
    )

    expect(detectOtelTraceApi()).toBeUndefined()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({
      logKey: 'LOGGER_OTEL_API_BROKEN',
      err: { type: 'TypeError' }
    })
  })

  it(/*
   * A failure on the FIRST anchor that the second anchor recovers from is not worth a
   * warning: correlation works.
   */
  'does not warn when the second anchor resolves the module', () => {
    const real = jest
      .requireActual<typeof import('node:module')>('node:module')
      .createRequire(__filename)
    mockedCreateRequire
      .mockImplementationOnce(requireThrows(new SyntaxError('first anchor is broken')))
      .mockImplementationOnce(() => real)

    expect(detectOtelTraceApi()).toBeDefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it(/*
   * A broken first anchor followed by a missing second one still leaves correlation off,
   * and the break is the part worth reporting.
   */
  'warns when the first anchor is broken and the second finds nothing', () => {
    mockedCreateRequire
      .mockImplementationOnce(requireThrows(new SyntaxError('first anchor is broken')))
      .mockImplementationOnce(requireThrows(notFound()))

    expect(detectOtelTraceApi()).toBeUndefined()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({ err: { message: 'first anchor is broken' } })
  })

  it(/*
   * A bundler that provides no `__filename` makes the first anchor itself throw. That is a
   * property of the environment, not a broken install: with the module absent it stays
   * silent (a bundled application without OpenTelemetry must not be warned at every
   * start), and with the module present the next anchor still finds it.
   */
  'treats an anchor that cannot be computed as nothing to resolve from', () => {
    const real = jest
      .requireActual<typeof import('node:module')>('node:module')
      .createRequire(__filename)
    const unavailable = (): string => {
      throw new ReferenceError('__filename is not defined')
    }

    mockedCreateRequire.mockImplementation(() => real)
    expect(detectOtelTraceApi([unavailable, () => __filename])).toBeDefined()

    mockedCreateRequire.mockImplementation(requireThrows(notFound()))
    expect(detectOtelTraceApi([unavailable, () => __filename])).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it(/*
   * A thrown value whose `code` getter throws cannot be classified as "not found", so it
   * is treated as a broken install and still reported once, with the stand-in error.
   */
  'treats a failure whose fields cannot be read as a broken install', () => {
    const hostile = {
      get code(): never {
        throw new Error('code getter exploded')
      }
    }
    mockedCreateRequire.mockImplementation(requireThrows(hostile))

    expect(detectOtelTraceApi()).toBeUndefined()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({ logKey: 'LOGGER_OTEL_API_BROKEN' })
  })

  it(/*
   * A cause whose fields cannot be read still produces the one line: the report degrades
   * to the stand-in for the error instead of throwing out of the detector.
   */
  'reports an unreadable failure with the stand-in error', () => {
    mockedCreateRequire.mockImplementation(requireThrows(Object.create(null)))

    expect(detectOtelTraceApi()).toBeUndefined()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({
      logKey: 'LOGGER_OTEL_API_BROKEN',
      err: { type: 'UnknownError', message: 'unreadable value' }
    })
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
