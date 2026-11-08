/**
 * Pins the event name derivation of a log entry and `withEventName`.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { withEventName } from './pino-factory'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { buildPinoInstance, createCapture } from './__tests__/pino-factory.fixtures'

describe('event name derivation', () => {
  /** Emit one structured entry and one variadic entry, returning both records. */
  function emit(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' }, ...overrides }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('PAYMENT_FAILED', 'Payment failed')
    logger.log('a plain nest-style message')
    return capture.entries()
  }

  it(/*
   * The event name is DERIVED, not mirrored. OTel's naming rules call for
   * lowercase dot-namespaced names, so emitting `PAYMENT_FAILED` verbatim would
   * produce a non-conforming event name and defeat the point of the field.
   * `logKey` itself is untouched — this is additive, never a rename.
   */
  'derives a lowercase dotted name and leaves logKey alone', () => {
    const [structured] = emit()

    expect(structured?.['event.name']).toBe('payment.failed')
    expect(structured?.['logKey']).toBe('PAYMENT_FAILED')
  })

  it(/*
   * The NestJS variadic bridge carries no log key, and an ordinary diagnostic
   * line is not an Event — so it correctly gets no event name rather than an
   * empty or fabricated one.
   */
  'omits the event name on calls that carry no log key', () => {
    const [, variadic] = emit()

    expect(variadic?.['event.name']).toBeUndefined()
    expect(variadic?.['msg']).toBe('a plain nest-style message')
  })

  it(/*
   * The field name is configurable because the value is meant to be mapped onto
   * the LogRecord's `EventName` field, and different pipelines read different
   * keys. The same-named OTLP *attribute* is deprecated, which is exactly why
   * the carrier key must not be hard-coded.
   */
  'honours a custom field name', () => {
    const [structured] = emit({ eventNameField: 'otel.event_name' })

    expect(structured?.['otel.event_name']).toBe('payment.failed')
    expect(structured?.['event.name']).toBeUndefined()
  })

  it(/*
   * `false` is a meaningful value, not an absent one — `??` in the defaults is
   * what preserves it, where `||` would silently restore the default.
   */
  'emits nothing when disabled', () => {
    const [structured] = emit({ eventNameField: false })

    expect(structured?.['event.name']).toBeUndefined()
    expect(structured?.['logKey']).toBe('PAYMENT_FAILED')
  })

  it.each([
    ['USER_AUTHENTICATION_FAILED', 'user.authentication.failed'],
    ['LOGGER_BOOTSTRAP_OK', 'logger.bootstrap.ok'],
    ['SINGLE', 'single']
  ])(
    /*
     * The mapping is exactly reversible for the `MODULE_ACTION_RESULT`
     * convention the library already enforces on log keys.
     */
    'maps %s to %s',
    (logKey, expected) => {
      const capture = createCapture()
      const logger = new PinoLoggerService(
        buildPinoInstance(
          applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
          new LogContextService(),
          [capture.destination]
        )
      )
      logger.info(logKey, 'message')

      expect(capture.entries()[0]?.['event.name']).toBe(expected)
    }
  )
})

describe('event name — degenerate log keys', () => {
  it(/*
   * An empty log key is not an event. Deriving from it would put `""` on the
   * entry, which is worse than absence: it asserts the record IS an Event and
   * names it nothing.
   */
  'emits no event name for an empty log key', () => {
    const capture = createCapture()
    const logger = new PinoLoggerService(
      buildPinoInstance(
        applyDefaults({ service: { name: 'svc', version: '1.0.0' } }),
        new LogContextService(),
        [capture.destination]
      )
    )
    logger.info('', 'message with no key')

    const entry = capture.entries()[0]
    expect(entry?.['event.name']).toBeUndefined()
  })
})

describe('withEventName (direct)', () => {
  it('writes nothing when disabled', () => {
    const out = withEventName({ logKey: 'PAYMENT_FAILED' }, false)

    expect('event.name' in out).toBe(false)
  })

  it.each([[''], [42], [undefined], [null]])(
    'writes nothing for a non-string or empty log key (%p)',
    (logKey) => {
      const out = withEventName({ logKey }, 'event.name')

      expect('event.name' in out).toBe(false)
    }
  )
})
