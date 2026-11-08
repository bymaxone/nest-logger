/**
 * Pins the `err` serializer, `errorFormat`, `serializeErrorValue`, `withSemconvException` and the stack scrubbing of an error entry.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { serializeErrorValue, withSemconvException } from './pino-factory'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { buildPinoInstance, createCapture } from './__tests__/pino-factory.fixtures'

describe('err serializer', () => {
  /** Emit one error entry and return the serialized `err` object. */
  function serializeThrough(
    value: unknown,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, ...overrides }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.errorStructured('OPERATION_FAILED', value as Error)
    return capture.entries()[0]?.['err'] as Record<string, unknown>
  }

  it(/*
   * REGRESSION — the defect the audit named. `pino.stdSerializers.err` derives
   * `type` from the value's CONSTRUCTOR, so anything already normalized into a
   * plain object — which is exactly what `HttpExceptionFilter` produces — came
   * out as `type: "Object"`. Every `ForbiddenException` in every error log was
   * mislabelled, and the earlier fix that read `error.name` was defeated one
   * layer below it.
   */
  'reports the real type for a plain error-like object, never "Object"', () => {
    const err = serializeThrough({ name: 'ForbiddenException', message: 'denied', stack: 'at x' })

    expect(err['type']).toBe('ForbiddenException')
    expect(err['type']).not.toBe('Object')
    expect(err['message']).toBe('denied')
  })

  it('reports the real type for a subclassed Error', () => {
    class PaymentDeclined extends Error {}
    const err = serializeThrough(new PaymentDeclined('card declined'))

    expect(err['type']).toBe('Error')
    expect(err['message']).toBe('card declined')
  })

  it(/*
   * A custom `name` is what typed exceptions set, and it must win over the
   * constructor — that is the whole distinction the regression erased.
   */
  'prefers a custom name over the constructor', () => {
    const error = new Error('denied')
    error.name = 'ForbiddenException'

    expect(serializeThrough(error)['type']).toBe('ForbiddenException')
  })

  it(/*
   * REGRESSION — `sanitizeError` computed the cause chain and the service threw
   * it away, so `Error.cause` never reached a log line. Modern JavaScript error
   * chaining was invisible in production.
   */
  'preserves an Error.cause chain', () => {
    const err = serializeThrough(
      new Error('outer', { cause: new Error('middle', { cause: new Error('root') }) })
    )

    const cause = err['cause'] as Record<string, unknown>
    expect(cause['message']).toBe('middle')
    expect((cause['cause'] as Record<string, unknown>)['message']).toBe('root')
  })

  it('preserves AggregateError members', () => {
    const err = serializeThrough(
      new AggregateError([new Error('first'), new Error('second')], 'both failed')
    )

    const members = err['errors'] as Record<string, unknown>[]
    expect(members).toHaveLength(2)
    expect(members[0]?.['message']).toBe('first')
  })

  it(/*
   * A cause cycle must not hang the serializer. The walk is circular-safe, and
   * this is the shape that would otherwise recurse forever.
   */
  'collapses a circular cause rather than recursing', () => {
    const outer = new Error('outer')
    const inner = new Error('inner')
    Object.defineProperty(outer, 'cause', { value: inner, enumerable: false })
    Object.defineProperty(inner, 'cause', { value: outer, enumerable: false })

    expect(() => serializeThrough(outer)).not.toThrow()
    expect(JSON.stringify(serializeThrough(outer))).toContain('Circular')
  })

  it(/*
   * `name`, `message` and `stack` are ordinary properties a caller can redefine
   * as throwing accessors — V8 already exposes `stack` as one. The record must
   * degrade rather than take the process down, and only the error node degrades:
   * the caller's `logKey` and metadata keep reaching the destination, because an
   * alert is keyed on the `logKey` and an unreadable error is no reason to lose it.
   *
   * The degradation happens at the REDACTION hook, which runs before the
   * serializer, so the node is the sanitizer's visible `SanitizeFailed` shape, not
   * the record-level envelope. That envelope stays for a record that really cannot
   * be read, pinned in `error-node-isolation.spec.ts`.
   */
  'degrades a hostile error to a marked error node and keeps the record', () => {
    const hostile = new Error('boom')
    Object.defineProperty(hostile, 'message', {
      get(): never {
        throw new Error('hostile message')
      }
    })
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )

    expect(() => {
      logger.errorStructured('OPERATION_FAILED', hostile)
    }).not.toThrow()

    const entry = capture.entries()[0]
    expect(entry).not.toHaveProperty('_redactionFailed')
    expect(entry?.['logKey']).toBe('OPERATION_FAILED')
    expect(entry?.['err']).toMatchObject({ type: 'SanitizeFailed' })
  })

  it(/*
   * The serializer's own never-throw guard, asserted where it actually runs.
   *
   * Going through the sink does not exercise this: the redaction hook reads the error
   * first. Calling the serializer directly reaches the guard, and the envelope is
   * asserted on its exact content rather than its type, because an empty stand-in would
   * be indistinguishable from a genuinely empty error. The unreadable property is the
   * one that identifies the error (its message): a missing stack or cause is a smaller
   * loss, which keeps the node and marks it, and is pinned in `sanitize-error.util.spec.ts`.
   */
  'degrades to the SanitizeFailed envelope when reading the value throws', () => {
    const hostile = { name: 'Weird' }
    Object.defineProperty(hostile, 'message', {
      get(): never {
        throw new Error('hostile message')
      },
      enumerable: false
    })

    let serialized: Record<string, unknown> | undefined
    expect(() => {
      serialized = serializeErrorValue(hostile)
    }).not.toThrow()
    expect(serialized).toEqual({
      type: 'SanitizeFailed',
      message: 'Failed to sanitize the thrown value'
    })
  })

  it(/*
   * The legacy key names are what every existing query, dashboard and alert
   * reads. The cause chain is additive on top of them, never a rename.
   */
  'keeps the legacy type/message/stack key names', () => {
    const err = serializeThrough(new Error('boom'))

    expect(Object.keys(err).sort()).toEqual(['message', 'stack', 'type'])
  })
})

describe('errorFormat', () => {
  /** Emit one error entry under the given format and return the whole record. */
  function emitError(errorFormat: 'pino' | 'semconv' | 'both'): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat }),
        new LogContextService(),
        [capture.destination]
      )
    )
    const error = new Error('card declined')
    error.name = 'PaymentDeclined'
    logger.errorStructured('PAYMENT_FAILED', error)
    return capture.entries()[0] as Record<string, unknown>
  }

  it(/*
   * The DEFAULT must not change what an existing consumer sees. `err.*` is what
   * every dashboard, alert and LogQL query already reads, so the semconv
   * attributes are opt-in rather than a silent addition to every record.
   */
  'emits only the legacy err object by default', () => {
    const entry = emitError('pino')

    expect(entry['err']).toMatchObject({ type: 'PaymentDeclined', message: 'card declined' })
    expect(entry['exception.type']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })

  it(/*
   * The semconv `exception.message` is copied from the error before the serializer runs, so it
   * is cut here at the same limit as the message of the `err` slot and as `msg`; a 100000
   * character message would otherwise be written whole in every semconv entry.
   */
  'cuts exception.message at the message limit in semconv and both modes', () => {
    for (const errorFormat of ['semconv', 'both'] as const) {
      const capture = createCapture()
      const logger = new PinoLoggerService(
        buildPinoInstance(
          applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat }),
          new LogContextService(),
          [capture.destination]
        )
      )

      logger.errorStructured('PAYMENT_FAILED', new Error('x'.repeat(100_000)))

      const entry = capture.entries()[0] as Record<string, unknown>
      expect(entry['exception.message']).toBe('x'.repeat(16_384) + '…[truncated]')
    }
  })

  it(/*
   * `exception.type` and `error.type` are copied from the error's name before the serializer
   * runs, so they are cut at the same limit as every other text copied from an error.
   */
  'cuts exception.type and error.type at the text limit in semconv and both modes', () => {
    for (const errorFormat of ['semconv', 'both'] as const) {
      const capture = createCapture()
      const logger = new PinoLoggerService(
        buildPinoInstance(
          applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat }),
          new LogContextService(),
          [capture.destination]
        )
      )

      logger.errorStructured(
        'PAYMENT_FAILED',
        Object.assign(new Error('x'), { name: 'N'.repeat(100_000) })
      )

      const entry = capture.entries()[0] as Record<string, unknown>
      expect(entry['exception.type']).toBe('N'.repeat(16_384) + '…[truncated]')
      expect(entry['error.type']).toBe('N'.repeat(16_384) + '…[truncated]')
    }
  })

  it(/*
   * All four attributes are Stable in SemConv v1.44.0. The spec requires at
   * least one of `exception.type` / `exception.message`; both are present here
   * because both come from the same value.
   */
  'emits the stable semconv attributes in semconv mode', () => {
    const entry = emitError('semconv')

    expect(entry['exception.type']).toBe('PaymentDeclined')
    expect(entry['exception.message']).toBe('card declined')
    expect(entry['exception.stacktrace']).toEqual(expect.any(String))
    expect(entry['error.type']).toBe('PaymentDeclined')
  })

  it(/*
   * REGRESSION — the legacy object is rebuilt out rather than `delete`d: the
   * redaction walk defines every property of its snapshot as non-configurable,
   * so `delete` throws `TypeError` and, caught, would silently leave `err` in
   * place. Measured behaviour, not an assumption about Pino.
   */
  'removes the legacy err object in semconv mode', () => {
    const entry = emitError('semconv')

    expect(entry).not.toHaveProperty('err')
    // …and the rest of the record survives the rebuild.
    expect(entry['logKey']).toBe('PAYMENT_FAILED')
    expect(entry['msg']).toBe('card declined')
  })

  it(/*
   * The migration path: nothing breaks and the new fields are already there, so
   * dashboards can move over one at a time.
   */
  'emits both shapes in both mode', () => {
    const entry = emitError('both')

    expect(entry['err']).toMatchObject({ type: 'PaymentDeclined' })
    expect(entry['exception.type']).toBe('PaymentDeclined')
    expect(entry['error.type']).toBe('PaymentDeclined')
  })

  it(/*
   * `error.type` must stay LOW cardinality — the spec is explicit that it
   * "SHOULD be predictable, and SHOULD have low cardinality". It carries the
   * class name, which is bounded by how many exception types a codebase defines;
   * putting the message there would make it unbounded and useless to aggregate.
   */
  'keeps error.type to the class name, never the message', () => {
    const entry = emitError('both')

    expect(entry['error.type']).toBe('PaymentDeclined')
    expect(entry['error.type']).not.toBe('card declined')
  })

  it(/*
   * An entry with no error must not gain empty exception attributes — an absent
   * attribute and one holding `undefined` mean different things to a consumer.
   */
  'adds nothing to an entry that carries no error', () => {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat: 'both' }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('USER_CREATED', 'created')

    const entry = capture.entries()[0] as Record<string, unknown>
    expect(entry['exception.type']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })
})

describe('semconv attributes — degenerate errors', () => {
  /** Emit an entry whose `err` field holds the given value. */
  function emitWithErr(err: unknown): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, errorFormat: 'both' }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('OPERATION_FAILED', 'message', undefined, { err })
    return capture.entries()[0] as Record<string, unknown>
  }

  it(/*
   * An `err` that carries none of the three readable fields must produce NO
   * exception attributes rather than attributes holding `undefined`. The spec
   * requires at least one of `exception.type` / `exception.message` to be
   * present, so emitting neither is the only correct answer for a value that has
   * neither — a half-populated set would assert something false.
   */
  'emits no exception attributes for an error-shaped value with no readable fields', () => {
    const entry = emitWithErr({ unrelated: 1 })

    expect(entry['exception.type']).toBeUndefined()
    expect(entry['exception.message']).toBeUndefined()
    expect(entry['exception.stacktrace']).toBeUndefined()
    expect(entry['error.type']).toBeUndefined()
  })

  it.each([['a string'], [42], [null]])(
    /*
     * A non-object `err` cannot carry exception attributes and must not crash the
     * hook that reads it.
     */
    'ignores a non-object err (%p)',
    (err) => {
      const entry = emitWithErr(err)

      expect(entry['exception.type']).toBeUndefined()
      expect(entry['logKey']).toBe('OPERATION_FAILED')
    }
  )

  it(/*
   * A value with a name but no message still yields the attributes it can
   * support — the spec's requirement is that at least ONE of type/message be
   * present, not both.
   */
  'emits only the attributes the value can support', () => {
    const entry = emitWithErr({ name: 'PartialError' })

    expect(entry['exception.type']).toBe('PartialError')
    expect(entry['error.type']).toBe('PartialError')
    expect(entry['exception.message']).toBeUndefined()
    expect(entry['exception.stacktrace']).toBeUndefined()
  })
})

describe('err serializer — field presence', () => {
  /** Serialize a value through a real instance and return the `err` object. */
  function errOf(value: unknown): Record<string, unknown> {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.errorStructured('OPERATION_FAILED', value as Error)
    return capture.entries()[0]?.['err'] as Record<string, unknown>
  }

  it(/*
   * An absent field must be ABSENT, not present holding `undefined`. A consumer
   * cannot distinguish `"cause": null` from a cause that genuinely was null, and
   * `JSON.stringify` drops `undefined` silently — so the only way this stays
   * honest is to never write the key.
   */
  'omits cause and errors for an error that has neither', () => {
    const err = errOf(new Error('plain'))

    expect(Object.keys(err)).not.toContain('cause')
    expect(Object.keys(err)).not.toContain('errors')
  })

  it('omits stack for an error-like value that has none', () => {
    const err = errOf({ name: 'NoStack', message: 'no stack here' })

    expect(Object.keys(err)).not.toContain('stack')
    expect(err['type']).toBe('NoStack')
  })

  it(/*
   * REGRESSION — `pino.stdSerializers.err` copied an error's own enumerable
   * properties, and applications rely on it: Node puts `code` on system errors,
   * HTTP layers put `statusCode`, domain code attaches its own fields. Dropping
   * them when the serializer was replaced would have been a silent compatibility
   * loss.
   */
  'copies an error own enumerable properties', () => {
    const error = Object.assign(new Error('failed'), { code: 'ECONNREFUSED', attempt: 3 })

    const err = errOf(error)

    expect(err['code']).toBe('ECONNREFUSED')
    expect(err['attempt']).toBe(3)
  })

  it(/*
   * An own property must never shadow a field the serializer owns. An error
   * carrying `type` would otherwise overwrite the real error type — reintroducing
   * exactly the mislabelling this serializer exists to fix.
   */
  'does not let an own property shadow the serialized type', () => {
    const error = Object.assign(new Error('failed'), { type: 'IMPOSTOR' })

    expect(errOf(error)['type']).toBe('Error')
  })
})

describe('serializeErrorValue (direct)', () => {
  it(/*
   * Asserted on the RETURNED object rather than through the sink. A field
   * written as `undefined` disappears from the serialized line — `JSON.stringify`
   * drops it — so a sink-level assertion cannot tell "omitted" from "written as
   * undefined". Mutation testing is what surfaced the gap.
   */
  'omits stack, cause and errors rather than writing them as undefined', () => {
    const serialized = serializeErrorValue({ name: 'Bare', message: 'no extras' })

    expect(Object.keys(serialized).sort()).toEqual(['message', 'type'])
    expect('stack' in serialized).toBe(false)
    expect('cause' in serialized).toBe(false)
    expect('errors' in serialized).toBe(false)
  })

  it('includes stack when the value has one', () => {
    const serialized = serializeErrorValue(new Error('boom'))

    expect('stack' in serialized).toBe(true)
    expect(serialized['stack']).toEqual(expect.any(String))
  })

  it('includes cause when the value has one', () => {
    const serialized = serializeErrorValue(new Error('outer', { cause: new Error('inner') }))

    expect('cause' in serialized).toBe(true)
  })

  it('includes errors for an AggregateError', () => {
    const serialized = serializeErrorValue(new AggregateError([new Error('a')], 'both'))

    expect('errors' in serialized).toBe(true)
  })
})

describe('withSemconvException (direct)', () => {
  /** A record shaped like one reaching `formatters.log`. */
  const recordWith = (err: unknown): Record<string, unknown> => ({ logKey: 'K_A_B', err })

  it('adds nothing under the pino format', () => {
    const out = withSemconvException(recordWith(new Error('boom')), 'pino')

    expect('exception.type' in out).toBe(false)
    expect('error.type' in out).toBe(false)
  })

  it(/*
   * A field the value cannot support must be ABSENT, not written as `undefined`:
   * the spec requires at least one of `exception.type` / `exception.message`, and
   * a key holding `undefined` satisfies neither while looking like it does.
   */
  'writes only the attributes the value supports', () => {
    const out = withSemconvException(recordWith({ name: 'PartialError' }), 'both')

    expect(out['exception.type']).toBe('PartialError')
    expect(out['error.type']).toBe('PartialError')
    expect('exception.message' in out).toBe(false)
    expect('exception.stacktrace' in out).toBe(false)
  })

  it.each([['a string'], [42], [null], [undefined]])(
    /*
     * A `null` or primitive `err` yields `undefined` for every field and must add
     * nothing — the reason the explicit type guard was removed: no input could
     * distinguish its presence.
     */
    'adds nothing for a non-object err (%p)',
    (err) => {
      const out = withSemconvException(recordWith(err), 'both')

      expect('exception.type' in out).toBe(false)
      expect('error.type' in out).toBe(false)
      expect(out['logKey']).toBe('K_A_B')
    }
  )

  it('drops the legacy err object only under the semconv format', () => {
    const withErr = withSemconvException(recordWith(new Error('boom')), 'both')
    const withoutErr = withSemconvException(recordWith(new Error('boom')), 'semconv')

    expect('err' in withErr).toBe(true)
    expect('err' in withoutErr).toBe(false)
    expect(withoutErr['logKey']).toBe('K_A_B')
  })
})

describe('exception.stacktrace scrubbing', () => {
  it(/*
   * The semconv attribute must carry the SAME scrubbed stack as the legacy
   * `err.stack`. Emitting one scrubbed and one raw would mean a consumer moving
   * to `errorFormat: 'semconv'` silently started seeing the dependency frames the
   * shape they migrated from had filtered out.
   */
  'strips node_modules frames from exception.stacktrace', () => {
    const error = new Error('boom')
    error.stack = [
      'Error: boom',
      '    at app (/srv/app/src/service.ts:1:1)',
      '    at dep (/srv/app/node_modules/pkg/index.js:2:2)'
    ].join('\n')

    const out = withSemconvException({ logKey: 'K_A_B', err: error }, 'both')

    expect(out['exception.stacktrace']).toContain('/srv/app/src/service.ts')
    expect(out['exception.stacktrace']).not.toContain('node_modules')
  })
})

describe('err serializer — non-object thrown values', () => {
  it.each<[unknown, string]>([
    ['thrown string', 'a string spreads its characters'],
    [[1, 2, 3], 'an array spreads its elements'],
    [42, 'a number'],
    [null, 'null']
  ])(
    /*
     * REGRESSION — the own-property copy ran on ANY value, and `Object.entries`
     * on a thrown STRING spreads its characters as indexed keys: a real record
     * carried `"0":"t","1":"h",…` beside the UnknownError envelope. Same for an
     * array's elements. The envelope's stringified message already carries the
     * whole value, so the copy adds only unqueryable noise and payload bloat.
     */
    'emits only the envelope for %p (%s)',
    (thrown) => {
      const serialized = serializeErrorValue(thrown)

      expect(Object.keys(serialized).sort()).toEqual(['message', 'type'])
      expect(serialized['type']).toBe('UnknownError')
      expect(serialized).not.toHaveProperty('0')
    }
  )
})
