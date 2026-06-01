import { Injectable } from '@nestjs/common'
import type { FactoryProvider } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import pino from 'pino'

import type { ILogDestination } from '../interfaces/log-destination.interface'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

import { InjectLogger } from './inject-logger.decorator'
import {
  collectContextLoggerProviders,
  collectContextLoggerTokens,
  createContextLoggerProvider,
  getContextLoggerToken
} from './inject-logger.provider'

const service = { name: 'inject-test', version: '1.0.0' }

/** In-memory destination capturing each emitted NDJSON line as a parsed entry. */
function createCapture(): { destination: ILogDestination; entries(): Record<string, unknown>[] } {
  const lines: string[] = []
  return {
    destination: {
      name: 'capture',
      write(line: string): void {
        lines.push(line)
      }
    },
    entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    }
  }
}

// Fixtures — their @InjectLogger decorators register contexts at class-definition
// time (module import), BEFORE any forRoot() below reads the registry.
@Injectable()
class UsersController {
  constructor(@InjectLogger('UsersController') readonly logger: PinoLoggerService) {}
}

@Injectable()
class OrdersController {
  constructor(@InjectLogger('OrdersController') readonly logger: PinoLoggerService) {}
}

@Injectable()
class RootConsumer {
  constructor(@InjectLogger() readonly logger: PinoLoggerService) {}
}

describe('getContextLoggerToken', () => {
  it(/*
   * The same context name must always resolve to the same token (memoized), so
   * the decorator's @Inject(token) and the module's provider agree.
   */
  'returns the same token for the same context', () => {
    expect(getContextLoggerToken('SameCtx')).toBe(getContextLoggerToken('SameCtx'))
  })

  it(/*
   * Distinct contexts must get distinct tokens, so each resolves to its own child.
   */
  'returns different tokens for different contexts', () => {
    expect(getContextLoggerToken('CtxAlpha')).not.toBe(getContextLoggerToken('CtxBeta'))
  })

  it(/*
   * The token symbol's description must embed the context (prefixed
   * `INJECTED_LOGGER_`) so DI errors and debugging surface a readable token name.
   */
  'names the token symbol after the context', () => {
    expect(getContextLoggerToken('DescCtx').description).toBe('INJECTED_LOGGER_DescCtx')
  })
})

describe('createContextLoggerProvider', () => {
  it(/*
   * The provider factory must return a child PinoLoggerService whose every entry
   * carries the bound context — without the caller setting it.
   */
  'produces a child logger whose entries carry the bound context', () => {
    const capture = createCapture()
    const root = new PinoLoggerService(pino({ base: {} }, capture.destination))
    const provider = createContextLoggerProvider('DirectCtx') as FactoryProvider

    const child = provider.useFactory(root)
    child.info('DIRECT_EVENT_OK', 'direct-msg')

    expect(child).toBeInstanceOf(PinoLoggerService)
    expect(capture.entries().find((entry) => entry['msg'] === 'direct-msg')?.['context']).toBe(
      'DirectCtx'
    )
  })
})

describe('collectContextLoggerProviders / collectContextLoggerTokens', () => {
  it(/*
   * Every discovered context must yield exactly one provider and one matching
   * token, so the module wires them consistently.
   */
  'expose one provider and one token per discovered context', () => {
    getContextLoggerToken('CollectProbe')
    expect(collectContextLoggerTokens()).toContain(getContextLoggerToken('CollectProbe'))
    expect(collectContextLoggerProviders()).toHaveLength(collectContextLoggerTokens().length)
  })
})

describe('@InjectLogger integration', () => {
  it(/*
   * A constructor param decorated with @InjectLogger('UsersController') must
   * receive a logger that stamps context: 'UsersController' on every entry — the
   * headline ergonomic contract for context-bound injection.
   */
  'injects a context-bound child logger', async () => {
    const capture = createCapture()
    const ref = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service, destinations: [capture.destination] })],
      providers: [UsersController]
    }).compile()

    ref.get(UsersController).logger.info('USER_FETCH_OK', 'fetched')

    expect(capture.entries().find((entry) => entry['msg'] === 'fetched')?.['context']).toBe(
      'UsersController'
    )
    await ref.close()
  })

  it(/*
   * Different contexts must resolve to DIFFERENT child instances — proof there is
   * no shared, mutated singleton being handed to every call site.
   */
  'gives different contexts different child instances', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({ service, destinations: [createCapture().destination] })
      ],
      providers: [UsersController, OrdersController]
    }).compile()

    expect(ref.get(UsersController).logger).not.toBe(ref.get(OrdersController).logger)
    await ref.close()
  })

  it(/*
   * @InjectLogger() with no context must still resolve to the shared root
   * PinoLoggerService, preserving backward compatibility with unparameterized injection.
   */
  'resolves the root PinoLoggerService when no context is given', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({ service, destinations: [createCapture().destination] })
      ],
      providers: [RootConsumer]
    }).compile()

    expect(ref.get(RootConsumer).logger).toBe(ref.get(PinoLoggerService, { strict: false }))
    await ref.close()
  })

  it(/*
   * The child-logger path must NEVER call setContext on the shared singleton —
   * doing so would race the context across feature modules. The binding rides on
   * the Pino child instead.
   */
  'never mutates the shared singleton via setContext', async () => {
    const setContextSpy = jest.spyOn(PinoLoggerService.prototype, 'setContext')
    const ref = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({ service, destinations: [createCapture().destination] })
      ],
      providers: [UsersController]
    }).compile()

    ref.get(UsersController)

    expect(setContextSpy).not.toHaveBeenCalled()
    await ref.close()
  })

  it(/*
   * AsyncLocalStorage context (requestId / tenantId) must survive into the child
   * logger's entries: the child inherits the root's trace mixin, so per-request
   * correlation is preserved alongside the bound context.
   */
  'preserves ALS context (requestId / tenantId) in child entries', async () => {
    const capture = createCapture()
    const ref = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service, destinations: [capture.destination] })],
      providers: [UsersController]
    }).compile()
    const users = ref.get(UsersController)
    const logContext = ref.get(LogContextService, { strict: false })

    logContext.run({ requestId: 'r_42', tenantId: 't_7' }, () =>
      users.logger.info('USER_CTX_OK', 'with-als')
    )

    const entry = capture.entries().find((item) => item['msg'] === 'with-als')
    expect(entry?.['context']).toBe('UsersController')
    expect(entry?.['requestId']).toBe('r_42')
    expect(entry?.['tenantId']).toBe('t_7')
    await ref.close()
  })
})
