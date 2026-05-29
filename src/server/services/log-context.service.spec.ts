import { LogContextService } from './log-context.service'

describe('LogContextService', () => {
  let service: LogContextService

  beforeEach(() => {
    service = new LogContextService()
  })

  it(/*
   * The store must be visible to synchronous code running inside run() — the
   * baseline propagation guarantee.
   */
  'propagates context to a synchronous callback', () => {
    service.run({ requestId: 'r_1' }, () => {
      expect(service.getStore()).toEqual({ requestId: 'r_1' })
    })
  })

  it(/*
   * AsyncLocalStorage must survive await boundaries, otherwise logs emitted
   * after the first await would lose their correlation IDs.
   */
  'propagates context across await boundaries', async () => {
    await service.run({ requestId: 'r_1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(service.get('requestId')).toBe('r_1')
    })
  })

  it(/*
   * Concurrent scopes must stay isolated — a failure here would leak one
   * request's context into another, the most dangerous AsyncLocalStorage bug.
   */
  'isolates context across parallel scopes', async () => {
    const seen: Record<string, string | undefined> = {}
    await Promise.all([
      service.run({ requestId: 'A' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        seen['A'] = service.get<string>('requestId')
      }),
      service.run({ requestId: 'B' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        seen['B'] = service.get<string>('requestId')
      })
    ])
    expect(seen).toEqual({ A: 'A', B: 'B' })
  })

  it(/*
   * Outside any scope, reads must be undefined rather than throwing, so logging
   * outside a request lifecycle degrades gracefully.
   */
  'returns undefined outside any scope', () => {
    expect(service.getStore()).toBeUndefined()
    expect(service.get('requestId')).toBeUndefined()
  })

  it(/*
   * set() outside a scope is a programming error and must fail loudly rather
   * than silently no-op.
   */
  'throws when set() is called outside a scope', () => {
    expect(() => service.set('userId', 'u_1')).toThrow(/outside run/i)
  })

  it(/*
   * set() inside a scope must mutate the active store so later logs in the same
   * request pick up the new field.
   */
  'allows set() to add a field inside a scope', () => {
    service.run({ requestId: 'r_1' }, () => {
      service.set('userId', 'u_1')
      expect(service.get('userId')).toBe('u_1')
      expect(service.getStore()).toEqual({ requestId: 'r_1', userId: 'u_1' })
    })
  })

  it(/*
   * set() must reject prototype-polluting keys so untrusted callers cannot
   * corrupt the store's prototype chain.
   */
  'rejects prototype-polluting keys', () => {
    service.run({ requestId: 'r_1' }, () => {
      expect(() => service.set('__proto__', { polluted: true })).toThrow(/unsafe context key/i)
      expect(() => service.set('constructor', {})).toThrow(/unsafe context key/i)
    })
  })

  it(/*
   * The generic on get<T> must surface the stored value at the caller-asserted
   * type.
   */
  'returns a typed value from get<T>', () => {
    service.run({ tenantId: 't_1' }, () => {
      const tenantId = service.get<string>('tenantId')
      expect(tenantId).toBe('t_1')
    })
  })
})
