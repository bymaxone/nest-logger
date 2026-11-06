/**
 * Pins that the arguments of the call a driver reports as failed are not written to the entry.
 * A driver error carries them as own fields (`command.args` on a Redis reply error, `parameters` on
 * a query error), and the redaction matches key names only, so a value inside a string argument
 * would reach the line. Driven through the real Pino pipeline, on the line a destination receives.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SESSION = JSON.stringify({ email: 'person@example.com', ip: '203.0.113.7' })

/** An error shaped like a Redis reply error: the failed command rides on it with its arguments. */
function replyError(): Error {
  return Object.assign(new Error('READONLY You can not write against a read only replica'), {
    name: 'ReplyError',
    command: { name: 'set', args: ['session:1', SESSION] }
  })
}

/** Logs `root` with `metadata` through the real pipeline and returns the line and its entry. */
function log(
  root: Error,
  metadata: Record<string, unknown> = {}
): { line: string; entry: Record<string, any> } {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  new PinoLoggerService(pino, resolveNameRedactor(options)).errorStructured(
    'KEY',
    root,
    'u1',
    metadata
  )
  return { line: lines[0] ?? '', entry: JSON.parse(lines[0] ?? '{}') }
}

describe('the arguments of a failed driver call', () => {
  it('keeps the command name of a reply error and drops its arguments', () => {
    const { line, entry } = log(replyError())

    expect(entry.err.command).toStrictEqual({ name: 'set' })
    expect(line).not.toContain('person@example.com')
    expect(line).not.toContain('203.0.113.7')
    expect(line).not.toContain('session:1')
  })

  it('does the same for a reply error that is the cause of the root error', () => {
    const { line, entry } = log(new Error('wrapped', { cause: replyError() }))

    expect(entry.err.cause.command).toStrictEqual({ name: 'set' })
    expect(line).not.toContain('person@example.com')
  })

  it('does the same for a reply error nested in the metadata', () => {
    const { line, entry } = log(new Error('root'), { failed: replyError() })

    expect(entry.failed.command).toStrictEqual({ name: 'set' })
    expect(line).not.toContain('person@example.com')
  })

  it.each(['args', 'parameters'])('drops an own %s field of an error', (field) => {
    const error = Object.assign(new Error('query failed'), { [field]: [SESSION], code: 'E_Q' })

    const { line, entry } = log(error, {
      nested: Object.assign(new Error('n'), { [field]: [SESSION] })
    })

    expect(entry.err.code).toBe('E_Q')
    expect(entry.err).not.toHaveProperty(field)
    expect(entry.nested).not.toHaveProperty(field)
    expect(line).not.toContain('person@example.com')
  })

  it('leaves a command that is not an object, and the fields next to it, as they are', () => {
    const error = Object.assign(new Error('spawn failed'), { command: 'ls -la', exitCode: 2 })

    const { entry } = log(error)

    expect(entry.err).toMatchObject({ command: 'ls -la', exitCode: 2 })
  })

  it('drops a command object that has no name to keep', () => {
    const { entry } = log(Object.assign(new Error('x'), { command: { args: [SESSION] } }))

    expect(entry.err).not.toHaveProperty('command')
  })

  it('reads the command name once, as the record walk pinned it', () => {
    let reads = 0
    const command = Object.defineProperty({ args: [SESSION] }, 'name', {
      enumerable: true,
      get: () => {
        reads++
        return 'set'
      }
    })

    const { entry, line } = log(Object.assign(new Error('x'), { command }))

    expect(reads).toBe(1)
    expect(entry.err.command).toStrictEqual({ name: 'set' })
    expect(line).not.toContain('person@example.com')
  })
})
