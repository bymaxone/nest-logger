import { firstValueFrom, of } from 'rxjs'
import type { CallHandler, ExecutionContext } from '@nestjs/common'

import { PassThroughInterceptor } from './passthrough.interceptor'

describe('PassThroughInterceptor', () => {
  it(/*
   * The pass-through must return the downstream handler's stream verbatim — it
   * stands in for the real HTTP interceptor when logging is disabled, so it must
   * add zero observable behavior.
   */
  'forwards the downstream stream untouched', async () => {
    const interceptor = new PassThroughInterceptor()
    const next: CallHandler = { handle: () => of('payload') }

    const result = await firstValueFrom(interceptor.intercept({} as ExecutionContext, next))

    expect(result).toBe('payload')
  })
})
