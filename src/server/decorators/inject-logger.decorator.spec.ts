import 'reflect-metadata'

import { Injectable } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import pino from 'pino'

import { INJECT_LOGGER_CONTEXT_METADATA_KEY, InjectLogger } from './inject-logger.decorator'
import { PinoLoggerService } from '../services/pino-logger.service'

describe('InjectLogger', () => {
  it(/*
   * When a context label is supplied it must be recorded under the param-slot
   * metadata key (`<propertyKey>:<index>`), which Phase 4 reads to auto-apply
   * setContext(). Constructor params have an undefined propertyKey → 'undefined:0'.
   */
  'records the context label as metadata when provided', () => {
    class WithContext {
      constructor(@InjectLogger('UsersService') readonly logger: PinoLoggerService) {}
    }

    expect(
      Reflect.getMetadata(INJECT_LOGGER_CONTEXT_METADATA_KEY, WithContext, 'undefined:0')
    ).toBe('UsersService')
  })

  it(/*
   * Without a context label no metadata may be written — covers the
   * `context !== undefined` false branch and proves the decorator stays a pure
   * @Inject convenience when unparameterized.
   */
  'records no context metadata when omitted', () => {
    class WithoutContext {
      constructor(@InjectLogger() readonly logger: PinoLoggerService) {}
    }

    expect(
      Reflect.getMetadata(INJECT_LOGGER_CONTEXT_METADATA_KEY, WithoutContext, 'undefined:0')
    ).toBeUndefined()
  })

  it(/*
   * The decorator must actually wire @Inject(PinoLoggerService): a DI resolution
   * of a class using @InjectLogger() must receive the registered logger instance.
   */
  'injects the PinoLoggerService instance via DI', async () => {
    const stub = new PinoLoggerService(pino({ enabled: false }))

    @Injectable()
    class Consumer {
      constructor(@InjectLogger() readonly logger: PinoLoggerService) {}
    }

    const moduleRef = await Test.createTestingModule({
      providers: [Consumer, { provide: PinoLoggerService, useValue: stub }]
    }).compile()

    expect(moduleRef.get(Consumer).logger).toBe(stub)
  })

  it(/*
   * The metadata key is read by the Phase 4 LoggerContextInterceptor and is part
   * of the contract; a rename would silently break context auto-application.
   */
  'exposes a stable metadata key', () => {
    expect(INJECT_LOGGER_CONTEXT_METADATA_KEY).toBe('bymax_logger:context')
  })
})
