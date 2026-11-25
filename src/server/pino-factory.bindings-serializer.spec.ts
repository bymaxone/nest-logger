/**
 * Pins what a consumer serializer on a resource binding receives when an extra of `service` is an
 * `Error`: the redactor of the bindings is told it walks the root of a record, and the serializer
 * is handed the `Error` itself, not a plain object that holds its parts.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'

/** What the serializer saw of `cause`, and the line it produced, for one resource format. */
function run(format: 'nested' | 'flat'): { answer: unknown; line: Record<string, unknown> } {
  const lines: string[] = []
  const take = (value: unknown): unknown => {
    const cause = value as object
    return { isError: cause instanceof Error, keys: Object.keys(cause) }
  }
  const options = applyDefaults({
    service: { name: 'app', version: '1', cause: Object.assign(new Error('x'), { extra: 1 }) },
    resourceFormat: format,
    serializers:
      format === 'nested'
        ? { service: (s: unknown): unknown => take((s as { cause: unknown }).cause) }
        : { 'service.cause': take }
  } as BymaxLoggerModuleOptions)
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )

  pino.info('hello')

  const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
  return { answer: format === 'nested' ? line['service'] : line['service.cause'], line }
}

describe('a serializer named for a resource binding', () => {
  /*
   * Given an Error with an own field, held in an extra of `service`, and a serializer for that binding
   * When the base is bound to the logger as the root of the bindings
   * Then the serializer receives the Error itself, with only its own field as a key
   */
  it.each(['nested', 'flat'] as const)('receives the Error in the %s format', (format) => {
    expect(run(format).answer).toStrictEqual({ isError: true, keys: ['extra'] })
  })
})
