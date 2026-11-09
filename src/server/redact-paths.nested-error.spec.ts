/**
 * Pins what an `Error` in a record looks like under `redactStrategy: 'paths'`: the same shape the
 * default `'names'` strategy writes (`type`, `message`, `stack`, its own fields and the chain of
 * its causes), the default names censored in its own fields and its causes at any depth, and the
 * consumer's paths applied on top. A value that is not an `Error` stays under the exact matching of
 * the configured paths, which is what the `'paths'` strategy is for. Driven through the real Pino
 * pipeline, on the line a destination receives.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

function written(extra: Partial<BymaxLoggerModuleOptions>, meta: Record<string, unknown>) {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  new PinoLoggerService(pino, resolveNameRedactor(options)).info('KEY', 'hello', 'u1', meta)
  return { line: lines[0] ?? '', entry: JSON.parse(lines[0] ?? '{}') as Record<string, any> }
}

const chain = (): Error => {
  const deepest = Object.assign(new Error('d3'), { password: 'LEAK-3', code: 'E3' })
  const middle = Object.assign(new Error('d2', { cause: deepest }), { password: 'LEAK-2' })
  return Object.assign(new Error('d1', { cause: middle }), { password: 'LEAK-1', statusCode: 500 })
}

const rows: [string, Partial<BymaxLoggerModuleOptions>][] = [
  ['no consumer path', { redactStrategy: 'paths' }],
  ['a.*.err.stack', { redactStrategy: 'paths', redactPaths: ['a.*.err.stack'] }],
  ['a.x.err.stack', { redactStrategy: 'paths', redactPaths: ['a.x.err.stack'] }],
  [
    'a.*.err.stack and an unrelated path',
    { redactStrategy: 'paths', redactPaths: ['a.x.unrelated', 'a.*.err.stack'] }
  ]
]

describe.each(rows)('an Error nested in the record, under paths with %s', (_name, extra) => {
  it('keeps its type, message, stack and own fields, as the names strategy does', () => {
    const { entry } = written(extra, { a: { x: { err: chain() } } })
    const error = entry['a'].x.err

    expect(error).toMatchObject({ type: 'Error', message: 'd1', statusCode: 500 })
    expect(typeof error.stack).toBe('string')
  })

  it('writes the chain of causes, and censors the default names at every link', () => {
    const { entry, line } = written(extra, { a: { x: { err: chain() } } })

    expect(entry['a'].x.err.cause).toMatchObject({ type: 'Error', message: 'd2' })
    expect(entry['a'].x.err.cause.cause).toMatchObject({ message: 'd3', code: 'E3' })
    expect(line).not.toContain('LEAK-')
    expect(entry['a'].x.err.cause.cause.password).toBe('[REDACTED]')
  })
})

describe('an Error under paths, beside the paths of the consumer', () => {
  it('has only the stack the path names censored, on top of the shape', () => {
    const { entry } = written(
      { redactStrategy: 'paths', redactPaths: ['a.*.err.stack'] },
      { a: { x: { err: chain() } }, e: chain() }
    )

    expect(entry['a'].x.err.stack).toBe('[REDACTED]')
    expect(entry['a'].x.err.message).toBe('d1')
    expect(entry['e'].stack).not.toBe('[REDACTED]')
  })

  it.each([
    ['at the top of the metadata', (e: Error) => ({ e })],
    ['in a list', (e: Error) => ({ list: [1, e] })],
    [
      'deeper than the paths of the default set reach',
      (e: Error) => ({ a: { b: { c: { d: { e } } } } })
    ]
  ])('writes the same shape, with no secret, for one %s', (_where, meta) => {
    const { line } = written({ redactStrategy: 'paths' }, meta(chain()))

    expect(line).toContain('"message":"d1"')
    expect(line).toContain('"message":"d3"')
    expect(line).not.toContain('LEAK-')
  })
})

describe('data that is not an Error, under paths', () => {
  const deep = (): Record<string, unknown> => ({
    a: { b: { c: { d: { e: { f: { password: 'KEEP-ME' } } } } } }
  })

  it('stays under the exact matching of the configured paths, beyond what the default paths reach', () => {
    const { line } = written({ redactStrategy: 'paths' }, deep())

    expect(line).toContain('KEEP-ME')
  })

  it('is censored by a configured path that matches it', () => {
    const { line } = written(
      { redactStrategy: 'paths', redactPaths: ['a.b.c.d.e.f.password'] },
      deep()
    )

    expect(line).not.toContain('KEEP-ME')
  })

  it('keeps a default name in clear inside it while the Error beside it is censored', () => {
    const { entry } = written(
      { redactStrategy: 'paths' },
      { a: { b: { c: { d: { e: { f: { password: 'KEEP-ME', err: chain() } } } } } } }
    )

    expect(entry['a'].b.c.d.e.f.password).toBe('KEEP-ME')
    expect(entry['a'].b.c.d.e.f.err.password).toBe('[REDACTED]')
  })
})

describe('an Error under paths when the default coverage is turned off', () => {
  it('censors only what the configured paths name, inside the Error as outside it', () => {
    const { entry } = written(
      { redactStrategy: 'paths', shouldDisableDefaultRedact: true, redactPaths: ['a.x.err.token'] },
      { a: { x: { err: Object.assign(new Error('boom'), { password: 'p-kept', token: 't' }) } } }
    )

    expect(entry['a'].x.err).toMatchObject({
      message: 'boom',
      password: 'p-kept',
      token: '[REDACTED]'
    })
  })
})
