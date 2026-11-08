/**
 * Pins that a Buffer, a typed array or a DataView in a record is written as its size, never as its
 * bytes and never by throwing, under both redaction strategies. Driven through the real Pino
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

function pipeline(extra: Partial<BymaxLoggerModuleOptions> = {}): {
  service: PinoLoggerService
  entry: () => Record<string, any>
  line: () => string
} {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino, resolveNameRedactor(options)),
    entry: () => JSON.parse(lines[0] ?? '{}'),
    line: () => lines[0] ?? ''
  }
}

/** Every way the redaction can be configured in which something is built to walk or to redact. */
const configurations: [string, Partial<BymaxLoggerModuleOptions>][] = [
  ['names, defaults', {}],
  [
    'names, defaults off, a path',
    { shouldDisableDefaultRedact: true, redactPaths: ['meta.secret'] }
  ],
  ['paths, defaults', { redactStrategy: 'paths' }],
  [
    'paths, defaults off, a path',
    { redactStrategy: 'paths', shouldDisableDefaultRedact: true, redactPaths: ['meta.secret'] }
  ]
]

describe.each(configurations)('a binary value in the record, with %s', (_name, extra) => {
  const payload = (): Record<string, unknown> => ({
    buf: Buffer.from('ab'),
    typed: new Uint8Array(3),
    view: new DataView(new ArrayBuffer(4)),
    err: Object.assign(new Error('n'), { stdout: Buffer.from('S') })
  })

  it('is written as its size in the metadata, and does not throw', () => {
    const { service, entry, line } = pipeline(extra)

    expect(() => service.info('KEY', 'hello', 'u1', { meta: payload() })).not.toThrow()

    expect(entry().meta.buf).toBe('[Binary 2 bytes]')
    expect(entry().meta.typed).toBe('[Binary 3 bytes]')
    expect(entry().meta.view).toBe('[Binary 4 bytes]')
    expect(line()).not.toContain('"data"')
  })

  it('is written as its size in the own field of an Error nested in the metadata', () => {
    const { service, entry, line } = pipeline(extra)

    expect(() => service.info('KEY', 'hello', 'u1', { meta: payload() })).not.toThrow()

    expect(entry().meta.err.stdout).toBe('[Binary 1 bytes]')
    expect(line()).not.toContain('"data"')
  })
})

describe('with nothing to redact', () => {
  it('does not throw for a binary value', () => {
    const { service, entry } = pipeline({ shouldDisableDefaultRedact: true })

    expect(() =>
      service.info('KEY', 'hello', 'u1', { meta: { buf: Buffer.from('ab') } })
    ).not.toThrow()

    expect(entry().meta.buf).toBeDefined()
  })
})
