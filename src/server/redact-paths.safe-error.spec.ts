/**
 * Pins what an `Error` that writes itself through `toJSON` becomes under `redactStrategy: 'paths'`
 * with `errorOwnFields: 'safe'`: the redaction walk converts it to data (`type`, `message`,
 * `stack`) and does not run its `toJSON`, so what that method returns, a secret or not, never
 * reaches the line. Under `'all'` the output of `toJSON` is what is written, with the default names
 * censored in it. The CHANGELOG's 1.4.16 note about the 1.4.15 entry rests on this behaviour.
 *
 * Layer: server, tests. Driven through the real Pino pipeline, on the line a destination receives.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

function written(extra: Partial<BymaxLoggerModuleOptions>, meta: Record<string, unknown>) {
  const lines: string[] = []
  const options = applyDefaults({
    service: { name: 'app', version: '1.0.0' },
    redactStrategy: 'paths',
    ...extra
  })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  new PinoLoggerService(pino, resolveNameRedactor(options)).info('KEY', 'hello', 'u1', meta)
  return { line: lines.join(''), entry: JSON.parse(lines[0] ?? '{}') as Record<string, any> }
}

/** An HTTP-client-shaped error: its `toJSON` returns a request, with a credential six levels down. */
function clientError(): Error {
  const error = new Error('upstream refused')
  Reflect.set(error, 'toJSON', () => ({
    marker: 'TOJSON-OUTPUT',
    config: { a: { b: { c: { d: { headers: { authorization: 'LEAK-DEEP' } } } } } }
  }))
  return error
}

describe("an Error with a toJSON, under redactStrategy 'paths'", () => {
  it("is written as data with errorOwnFields 'safe', and its toJSON output is absent", () => {
    const { line, entry } = written({ errorOwnFields: 'safe' }, { top: clientError() })

    expect(entry['top']).toMatchObject({ type: 'Error', message: 'upstream refused' })
    expect(typeof entry['top'].stack).toBe('string')
    expect(line).not.toContain('LEAK-DEEP')
    expect(line).not.toContain('TOJSON-OUTPUT')
  })

  it("writes what its toJSON returns with errorOwnFields 'all', the secret censored", () => {
    const { line } = written({ errorOwnFields: 'all' }, { top: clientError() })

    expect(line).toContain('TOJSON-OUTPUT')
    expect(line).not.toContain('LEAK-DEEP')
  })
})
