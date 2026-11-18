/**
 * Pins that the factory gives the censor of the `message` of an entry to the two places it builds
 * that write a line about a failure: the stream of each destination, which reports a write that was
 * refused, and the mixin, which reports a trace API that cannot be read. The error of the host is in
 * `err` of those lines, and its message is hidden as `err.message` of an entry is.
 *
 * Layer: server, tests. Driven through the real factory; the trace API is a stand-in that throws.
 */
jest.mock('./utils/otel-detector', () => ({
  ...jest.requireActual<typeof import('./utils/otel-detector')>('./utils/otel-detector'),
  detectOtelTraceApi: jest.fn()
}))

import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { detectOtelTraceApi, resetBrokenInstallWarning } from './utils/otel-detector'

const mockedDetect = jest.mocked(detectOtelTraceApi)

const LEAK = 'connect to https://user:SECRET@host'

/** The lines the library wrote to stderr, parsed. */
function stderrLines(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

describe('the factory and the lines the library writes about a failure', () => {
  let stderr: jest.SpyInstance

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    resetBrokenInstallWarning()
    mockedDetect.mockReset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /** An entry logged through a factory built from `extra`, over `destinations`. */
  const logOne = (
    extra: Partial<BymaxLoggerModuleOptions>,
    destinations: readonly ILogDestination[]
  ): void => {
    const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
    const pino = buildPinoInstance(
      options,
      new LogContextService(),
      destinations,
      new DestinationHealth()
    )
    new PinoLoggerService(pino).info('K', 'an entry')
  }

  it.each([
    ['a name in redactPaths hides it', { redactPaths: ['message'] }, '[REDACTED]'],
    ['a censor of its own is the text', { redactPaths: ['message'], redactCensor: '<x>' }, '<x>'],
    ['no name in redactPaths leaves it', {}, LEAK]
  ])(
    'writes err.message of a refused write as the options censor it: %s',
    (_l, extra, expected) => {
      const refusing: ILogDestination = {
        name: 'refusing',
        write(): void {
          throw new Error(LEAK)
        }
      }

      logOne(extra, [refusing])

      const failure = stderrLines(stderr).find(
        (l) => l['logKey'] === 'LOGGER_DESTINATION_WRITE_FAILED'
      )
      expect(failure?.['err']).toEqual({ type: 'Error', message: expected })
    }
  )

  /*
   * `maxStringLength` does not apply to the log message, so the censor of the message of an error in
   * a line about a failure does not cut at it either, and a text that is not cut is not counted as
   * a cut. Read on an instance the factory built, which carries the finisher that has the limit.
   */
  it('censors a text without cutting it at maxStringLength, and without counting a cut', () => {
    const health = new DestinationHealth()
    const options = applyDefaults({
      service: { name: 'app', version: '1.0.0' },
      maxStringLength: 64
    })
    const pino = buildPinoInstance(options, new LogContextService(), [], health)
    const long = 'x'.repeat(500)

    expect(new PinoLoggerService(pino).censorMessageText(long)).toBe(long)
    expect(health.truncatedTotal('max_string_length')).toBe(0)
  })

  it('gives the mixin the censor, so the warning of a trace API that cannot be read hides it', () => {
    mockedDetect.mockReturnValue({
      getActiveSpan: () => {
        throw new Error(LEAK)
      }
    } as never)
    const quiet: ILogDestination = { name: 'quiet', write: () => undefined }

    logOne({ redactPaths: ['message'], otel: { shouldAutoInjectTraceContext: true } }, [quiet])

    const warning = stderrLines(stderr).find((l) => l['logKey'] === 'LOGGER_OTEL_API_BROKEN')
    expect(warning?.['err']).toEqual({ type: 'Error', message: '[REDACTED]' })
    expect(mockedDetect).toHaveBeenCalledWith(undefined, expect.any(Function))
  })
})
