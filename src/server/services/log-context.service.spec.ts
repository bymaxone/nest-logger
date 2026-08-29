import type { LogContext } from '../interfaces/log-context.interface'

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
   * run() must strip prototype-polluting keys from a caller-supplied context
   * (e.g. an own `__proto__` from JSON.parse of an untrusted payload) so they
   * never reach the store — defense in depth matching the set() guard.
   */
  'strips prototype-polluting keys from the run() context', () => {
    const polluted = JSON.parse(
      '{"requestId":"r_1","__proto__":{"x":1},"constructor":"c"}'
    ) as LogContext
    service.run(polluted, () => {
      expect(service.getStore()).toEqual({ requestId: 'r_1' })
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
  it(/*
   * runMerged() must EXTEND the enclosing scope rather than replace it: the
   * outer requestId survives while the inner userId is added. This is the whole
   * reason the method exists — plain run() drops the outer field silently, which
   * is how a tenantId resolved at the edge went missing for a whole request.
   */
  'carries the enclosing context into a merged scope', () => {
    service.run({ requestId: 'r_1', tenantId: 't_1' }, () => {
      service.runMerged({ userId: 'u_1' }, () => {
        expect(service.getStore()).toEqual({ requestId: 'r_1', tenantId: 't_1', userId: 'u_1' })
      })
    })
  })

  it(/*
   * On a key present in both, the INNER value wins — the merged scope is a
   * refinement of the outer one, so the caller's own field must not be shadowed
   * by the value it is refining.
   */
  'lets the inner context override an enclosing field', () => {
    service.run({ requestId: 'r_1', tenantId: 't_outer' }, () => {
      service.runMerged({ tenantId: 't_inner' }, () => {
        expect(service.get('tenantId')).toBe('t_inner')
        expect(service.get('requestId')).toBe('r_1')
      })
    })
  })

  it(/*
   * Outside any scope there is nothing to merge, so runMerged must behave
   * exactly like run(). Pins the `{ ...undefined }` spread that covers this
   * without a branch: an explicit guard here would have arms that cannot differ.
   */
  'behaves like run() when there is no enclosing scope', () => {
    service.runMerged({ requestId: 'r_1' }, () => {
      expect(service.getStore()).toEqual({ requestId: 'r_1' })
    })
  })

  it(/*
   * The merge must produce a FRESH object: a write inside the merged scope must
   * not reach the enclosing context, or an inner scope would silently mutate its
   * caller's state after the callback returned.
   */
  'leaves the enclosing context untouched after the merged scope ends', () => {
    service.run({ requestId: 'r_1' }, () => {
      service.runMerged({}, () => {
        service.set('userId', 'u_1')
      })
      expect(service.getStore()).toEqual({ requestId: 'r_1' })
    })
  })

  it(/*
   * The same prototype-pollution guard run() enforces must apply to the merged
   * context — an own `__proto__` from an untrusted payload cannot reach the store
   * through the merging door either.
   */
  'strips prototype-polluting keys from the merged context', () => {
    const polluted = JSON.parse('{"userId":"u_1","__proto__":{"x":1}}') as LogContext
    service.run({ requestId: 'r_1' }, () => {
      service.runMerged(polluted, () => {
        expect(service.getStore()).toEqual({ requestId: 'r_1', userId: 'u_1' })
      })
    })
  })

  it(/*
   * The callback's return value must flow back out, matching run()'s contract —
   * a merged scope is a scope, not a fire-and-forget.
   */
  'returns the callback result', () => {
    expect(service.runMerged({ requestId: 'r_1' }, () => 42)).toBe(42)
  })
})
