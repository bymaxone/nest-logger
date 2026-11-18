/**
 * E2E: a payload key that names a prototype (`__proto__`, `constructor`, `prototype`) never reaches
 * a prototype and never runs a setter, in every path that merges caller data into an entry: an
 * object message, the metadata of the structured methods, child bindings, and the merge of the
 * mixin result (reached through the raw Pino logger). Each row also checks the positive control (the
 * line was written with the row's marker) and that the keys the logger writes from the request
 * context are intact.
 *
 * Layer: e2e, server (the whole logger through the module wiring).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, LogContextService, PinoLoggerService } from '@bymax-one/nest-logger'
import type { ILogDestination } from '@bymax-one/nest-logger'

class Collector implements ILogDestination {
  readonly name = 'collector'
  readonly lines: string[] = []

  write(payload: string): void {
    this.lines.push(payload)
  }
}

/** The payload keys that name a prototype, each carrying a prototype-shaped value. */
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'] as const

/**
 * A payload whose own key `key` holds a value that carries a polluting property and a setter for
 * `requestId`; `__proto__` is defined as an own data property, as `JSON.parse` does.
 */
function hostilePayload(
  key: string,
  mark: string,
  calls: { setter: number }
): Record<string, unknown> {
  const carried = Object.defineProperty({ polluted: true }, 'requestId', {
    set: () => {
      calls.setter += 1
    },
    enumerable: true,
    configurable: true
  })
  return Object.defineProperty({ marker: mark }, key, {
    value: carried,
    enumerable: true,
    configurable: true,
    writable: true
  }) as Record<string, unknown>
}

type Emit = (payload: Record<string, unknown>, logger: Logger, service: PinoLoggerService) => void

const PATHS: ReadonlyArray<readonly [string, Emit]> = [
  ['an object message', (p, l) => l.warn(p)],
  ['the metadata of info', (p, _l, s) => s.info('ROW_INFO', 'text', undefined, p)],
  [
    'the metadata of warnStructured',
    (p, _l, s) => s.warnStructured('ROW_WARN', 'text', undefined, p)
  ],
  [
    'the metadata of errorStructured',
    (p, _l, s) => s.errorStructured('ROW_ERROR', new Error('boom'), undefined, p)
  ],
  ['child bindings', (p, _l, s) => s.child(p).warn('child line')],
  ['the merge of the mixin result (raw logger)', (p, _l, s) => s.getRawLogger().info(p, 'raw line')]
]

describe.each(PROTOTYPE_KEYS)('a payload key named %s', (key) => {
  it.each(PATHS)('reaches no prototype and runs no setter through %s', async (_name, emit) => {
    const collector = new Collector()

    @Module({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-prototype-keys', version: '0.0.0' },
          destinations: [collector]
        })
      ]
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
    app.useLogger(app.get(PinoLoggerService))
    const booted = collector.lines.length
    const calls = { setter: 0 }
    const logContext = app.get(LogContextService, { strict: false })

    logContext.run({ requestId: 'r_als' }, () =>
      emit(
        hostilePayload(key, 'ROW-MARKER', calls),
        new Logger('Proto'),
        app.get(PinoLoggerService)
      )
    )
    await app.close()

    const written = collector.lines
      .slice(booted)
      .filter((line) => !line.includes('"LOGGER_'))
      .join('\n')
    expect(written).toContain('ROW-MARKER')
    expect(written).toContain('"requestId":"r_als"')
    expect(written).not.toContain('forged')
    expect(calls.setter).toBe(0)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype).not.toHaveProperty('requestId')
  })
})
