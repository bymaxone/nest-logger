/**
 * Pins when `BymaxLoggerModule` mounts the error layer that keeps a body-parser error's type for
 * the exception filter: on an Express adapter, and nowhere else. The behaviour through a real Nest
 * application is in `test/e2e/body-parser-errors.e2e-spec.ts`.
 *
 * Layer: server, tests.
 */
import type { HttpAdapterHost } from '@nestjs/core'

import { BymaxLoggerModule } from './logger.module'
import { recordParserErrorMiddleware } from './middlewares/record-parser-error.middleware'

function moduleWith(adapter: { getType(): string; getInstance(): { use: jest.Mock } } | undefined) {
  return new BymaxLoggerModule({ httpAdapter: adapter } as unknown as HttpAdapterHost)
}

describe('BymaxLoggerModule.configure, the error layer for a body-parser error', () => {
  it('mounts the layer on an Express adapter', () => {
    const use = jest.fn()

    moduleWith({ getType: () => 'express', getInstance: () => ({ use }) }).configure(
      undefined as never
    )

    expect(use).toHaveBeenCalledTimes(1)
    expect(use).toHaveBeenCalledWith(recordParserErrorMiddleware)
  })

  it('mounts nothing on an adapter that is not Express', () => {
    const use = jest.fn()

    moduleWith({ getType: () => 'fastify', getInstance: () => ({ use }) }).configure(
      undefined as never
    )

    expect(use).not.toHaveBeenCalled()
  })

  it('mounts nothing, and does not throw, when there is no HTTP adapter', () => {
    expect(() => moduleWith(undefined).configure(undefined as never)).not.toThrow()
  })
})
