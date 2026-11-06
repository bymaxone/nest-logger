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

/** An error shaped like the one pg raises for a unique violation, with the fields pg sets. */
function uniqueViolation(extra: Record<string, unknown> = {}): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    {
      name: 'error',
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (email)=(person@example.com) already exists.',
      where: 'SQL statement "INSERT INTO users(email) VALUES (\'person@example.com\')"',
      internalQuery: "INSERT INTO users(email) VALUES ('person@example.com')",
      hint: 'Use a different value.',
      schema: 'public',
      table: 'users',
      column: 'email',
      constraint: 'users_email_key',
      file: 'nbtinsert.c',
      line: '666',
      routine: '_bt_check_unique',
      ...extra
    }
  )
}

describe('the row values a database error quotes', () => {
  it('drops the detail, where and internal query of a pg error and keeps the names', () => {
    const { line, entry } = log(uniqueViolation())

    expect(entry.err).toMatchObject({
      severity: 'ERROR',
      code: '23505',
      schema: 'public',
      table: 'users',
      column: 'email',
      constraint: 'users_email_key',
      routine: '_bt_check_unique'
    })
    for (const field of ['detail', 'where', 'internalQuery']) {
      expect(entry.err).not.toHaveProperty(field)
    }
    expect(line).not.toContain('person@example.com')
  })

  it('does the same as a cause and nested in the metadata', () => {
    const { line, entry } = log(new Error('wrapped', { cause: uniqueViolation() }), {
      failed: uniqueViolation()
    })

    expect(entry.err.cause).not.toHaveProperty('detail')
    expect(entry.failed).not.toHaveProperty('detail')
    expect(line).not.toContain('person@example.com')
  })

  it.each([
    ['no severity', { severity: undefined }],
    ['no routine', { routine: undefined }],
    [
      'neither severity, routine, file nor line',
      {
        severity: undefined,
        routine: undefined,
        file: undefined,
        line: undefined
      }
    ]
  ])('drops the quoting fields of a SQLSTATE-coded error with %s', (_label, change) => {
    const { line, entry } = log(uniqueViolation(change))

    expect(entry.err).toMatchObject({ code: '23505', constraint: 'users_email_key' })
    for (const field of ['detail', 'where', 'internalQuery']) {
      expect(entry.err).not.toHaveProperty(field)
    }
    expect(line).not.toContain('person@example.com')
  })

  it.each([
    ['a code of an operating-system error', { code: 'EPIPE' }],
    ['a code of another length', { code: '2350' }],
    ['a lowercase code', { code: '23a05' }],
    ['a numeric code', { code: 23505 }],
    ['no code', { code: undefined }]
  ])('leaves detail alone on an error with %s', (_label, change) => {
    const { entry } = log(uniqueViolation(change))

    expect(entry.err.detail).toBe('Key (email)=(person@example.com) already exists.')
  })
})

describe('a driver error held as a field of another error', () => {
  /** A TypeORM-shaped error: the pg error rides on it and its fields are copied onto it. */
  const wrapper = (): Error => {
    const driverError = uniqueViolation()
    return Object.assign(new Error('query failed'), {
      name: 'QueryFailedError',
      query: 'INSERT INTO users(email) VALUES ($1)',
      parameters: ['person@example.com'],
      driverError,
      severity: 'ERROR',
      code: '23505',
      routine: '_bt_check_unique',
      detail: 'Key (email)=(person@example.com) already exists.'
    })
  }

  it.each([
    ['the root error', (e: Error) => log(e)],
    ['a cause', (e: Error) => log(new Error('wrapped', { cause: e }))],
    ['the metadata', (e: Error) => log(new Error('root'), { failed: e })]
  ])('writes neither the row nor the arguments when it is held by %s', (_label, run) => {
    const { line } = run(wrapper())

    expect(line).not.toContain('person@example.com')
  })

  it('removes the quoting fields from the held error itself, and keeps its names', () => {
    const { entry } = log(wrapper())

    expect(entry.err.driverError).toMatchObject({
      code: '23505',
      table: 'users',
      constraint: 'users_email_key'
    })
    for (const held of [entry.err.driverError, entry.err]) {
      for (const field of ['detail', 'where', 'internalQuery']) {
        expect(held).not.toHaveProperty(field)
      }
    }
  })

  it('does the same for a reply error held as the parent of another error', () => {
    const { line, entry } = log(Object.assign(new Error('sequelize'), { parent: replyError() }))

    expect(entry.err.parent.command).toStrictEqual({ name: 'set' })
    expect(line).not.toContain('person@example.com')
  })

  it.each(['Args', 'ARGS', 'Parameters', 'PARAMETERS'])(
    'drops the field %s whatever its case',
    (field) => {
      const { entry, line } = log(
        Object.assign(new Error('x'), { [field]: [SESSION], code: 'E_X' })
      )

      expect(entry.err).toMatchObject({ code: 'E_X' })
      expect(entry.err).not.toHaveProperty(field)
      expect(line).not.toContain('person@example.com')
    }
  )
})
