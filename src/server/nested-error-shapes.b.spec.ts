/**
 * Shapes of a nested `Error`, part B: each is logged through the real pipeline and judged
 * against the entry 1.4.8 wrote for the same shape (`__tests__/nested-error-shapes.b.base.json`).
 *
 * A shape passes when the new entry neither throws nor fails the whole record where 1.4.8 did
 * not, shows no marker of a secret that 1.4.8 did not, and keeps every leaf VALUE 1.4.8 emitted
 * (keys may change, values may not). The shapes cover the credential
 * written through an `Error` that defines `toJSON`, the `cause` and `errors` that are not shaped
 * like an `Error`, and the prototype, proxy, symbol, getter, realm and serializer cases around them.
 *
 * Layer: server, tests. To record a base, run this file with `RECORD_SHAPES=<path>` on the tree
 * whose output is the reference.
 */
import { writeFileSync } from 'node:fs'
import vm from 'node:vm'

import { axios, judge, loadBase, run, type Shape } from './__tests__/nested-error-shapes.runner'

const cases: Record<string, () => Shape> = {}
const add = (name: string, make: () => any): void => {
  cases[name] = make
}

add('classfield-cause', () => {
  class E extends Error {
    override cause = new Error('cf', { cause: new Error('cf2') })
  }
  return { meta: { inner: new E('x') } }
})
add('classfield-held', () => {
  class E extends Error {
    held = new Error('h', { cause: new Error('h2') })
  }
  return { meta: { inner: new E('x') } }
})
add('classfield-under-serializer', () => {
  class E extends Error {
    errors = [new Error('e1')]
    override cause = new Error('c')
    held = new Error('h')
  }
  return {
    meta: { thing: new E('x') },
    extra: {
      serializers: {
        thing: (e: any) => ({
          isE: e instanceof Error,
          cause: e.cause instanceof Error,
          held: e.held instanceof Error,
          errs: e.errors?.[0] instanceof Error,
          held2: e.held
        })
      }
    }
  }
})
add('realm-nested', () => ({
  meta: { inner: vm.runInNewContext('new Error("realm", {cause: new Error("rc")})') }
}))
add('realm-root', () => ({ root: vm.runInNewContext('new Error("realm")'), meta: {} }))
add('realm-cause', () => ({
  meta: { inner: new Error('o', { cause: vm.runInNewContext('new Error("rc")') }) }
}))
add('realm-errors', () => ({
  meta: { inner: new AggregateError([vm.runInNewContext('new Error("re")')], 'a') }
}))
add('realm-field', () => ({
  meta: {
    inner: Object.assign(new Error('o'), {
      w: vm.runInNewContext('Object.assign(new Error("rf"), {password:"P", leak:"LEAKR"})')
    })
  }
}))
add('realm-toJSON', () => ({
  meta: {
    inner: vm.runInNewContext(
      'Object.assign(new Error("rt"), {toJSON(){return {a:1}}, request:{_header:"Bearer LEAKRT"}})'
    )
  }
}))
add('ser-err-identity', () => ({
  meta: { err: new Error('e', { cause: new Error('c') }) },
  extra: { serializers: { err: (e: any) => e } }
}))
add('ser-err-reads-cause', () => ({
  meta: { err: new Error('e', { cause: new Error('c') }) },
  extra: { serializers: { err: (e: any) => ({ ci: e.cause instanceof Error, m: e.message }) } }
}))
add('ser-err-returns-error', () => ({
  meta: { err: new Error('e') },
  extra: { serializers: { err: (e: any) => new Error('r', { cause: e }) } }
}))
add('ser-err-throws', () => ({
  meta: { err: new Error('e') },
  extra: {
    serializers: {
      err: () => {
        throw new Error('s')
      }
    }
  }
}))
add('ser-custom-returns-error', () => ({
  meta: { thing: new Error('e', { cause: new Error('c') }) },
  extra: {
    serializers: {
      thing: (e: any) => Object.assign(new Error('r', { cause: e.cause }), { password: 'PW' })
    }
  }
}))
add('ser-custom-throws', () => ({
  meta: { thing: new Error('e') },
  extra: {
    serializers: {
      thing: () => {
        throw new Error('s')
      }
    }
  }
}))
add('ser-custom-nested-error', () => ({
  meta: { thing: { inner: new Error('e', { cause: axios() }), list: [new Error('l')] } },
  extra: {
    serializers: {
      thing: (v: any) => ({ i: v.inner instanceof Error, l: v.list[0] instanceof Error, v })
    }
  }
}))
add('ser-custom-child', () => ({
  child: { thing: new Error('e', { cause: new Error('c') }) },
  meta: {},
  extra: {
    serializers: { thing: (e: any) => ({ i: e instanceof Error, c: e.cause instanceof Error }) }
  }
}))
add('ser-custom-child-nested-key', () => ({
  child: { wrap: { thing: new Error('e') } },
  meta: {},
  extra: { serializers: { thing: (e: any) => ({ i: e instanceof Error }) } }
}))
add('child-err-key', () => ({
  child: { err: new Error('c', { cause: new Error('cc') }) },
  meta: {}
}))
add('child-plain', () => ({
  child: { inner: new Error('c', { cause: new Error('cc') }) },
  meta: {}
}))
add('child-toJSON', () => ({ child: { inner: axios() }, meta: {} }))
add('accessor-name', () => {
  class A extends Error {
    override get name() {
      return 'AccName'
    }
    override get message() {
      return 'accmsg'
    }
    override get stack() {
      return 'accstack'
    }
  }
  return { meta: { inner: new A() } }
})
add('accessor-throw', () => {
  class A extends Error {
    override get message(): string {
      throw new Error('m')
    }
  }
  return { meta: { inner: new A() } }
})
add('frozen', () => ({
  meta: {
    inner: Object.freeze(Object.assign(new Error('fz'), { list: [1, { a: 2 }], password: 'p' }))
  }
}))
add('sealed', () => ({
  meta: { inner: Object.seal(Object.assign(new Error('sl'), { list: [1], cause: new Error('x') })) }
}))
add('shared', () => {
  const e = new Error('sh')
  return { meta: { a: e, b: e, c: [e, e] } }
})
add('cycle-cause', () => {
  const a: any = new Error('a')
  const b: any = new Error('b', { cause: a })
  a.cause = b
  return { meta: { inner: a } }
})
add('cycle-errors', () => {
  const a: any = new AggregateError([], 'a')
  a.errors.push(a)
  return { meta: { inner: a } }
})
add('cycle-field', () => {
  const a: any = new Error('a')
  a.self = a
  a.o = { back: a }
  return { meta: { inner: a } }
})
add('cycle-toJSON-out', () => {
  const a: any = new Error('a')
  a.toJSON = () => ({ me: a })
  return { meta: { inner: a } }
})
add('cycle-toJSON-out2', () => {
  const a: any = new Error('a')
  a.toJSON = () => ({ list: [a] })
  return { meta: { inner: a } }
})
add('cycle-under-ser', () => {
  const a: any = new Error('a')
  a.self = a
  return { meta: { err: a } }
})
add('depth-ceiling', () => {
  let o: any = new Error('deep')
  for (let i = 0; i < 98; i++) o = { o }
  return { meta: { o } }
})
add('depth-ceiling2', () => {
  let o: any = new Error('deep', { cause: new Error('c') })
  for (let i = 0; i < 99; i++) o = { o }
  return { meta: { o } }
})
add('depth-ceiling3', () => {
  let o: any = Object.assign(new Error('deep'), { f: { g: 1 } })
  for (let i = 0; i < 97; i++) o = { o }
  return { meta: { o } }
})
add('chain-12', () => {
  let e: any = new Error('d0')
  for (let i = 1; i < 12; i++) e = new Error('d' + i, { cause: e })
  return { meta: { inner: e } }
})
add('chain-cause-nonenum-secret', () => ({
  meta: {
    inner: new Error('o', {
      cause: Object.assign(new Error('c'), { accessToken: 'AT', leakx: 'ok' })
    })
  }
}))
add('arr-holes-error', () => {
  const holes: unknown[] = [new Error('a')]
  holes[2] = new Error('b')
  return { meta: { inner: holes } }
})
add('error-subclass-ownenum-array', () => ({
  meta: { inner: Object.assign(new Error('o'), { items: [1, 2, { password: 'x' }] }) }
}))
add('toJSON-fn-on-field', () => ({
  meta: {
    inner: Object.assign(new Error('o'), { field: { toJSON: () => ({ password: 'x', y: 1 }) } })
  }
}))
add('bindings-sym', () => ({
  child: { inner: Object.assign(new Error('o'), { [Symbol('s')]: 'S' }) },
  meta: {}
}))
add('toJSON-nonerror-w-error-field', () => ({
  meta: { inner: { toJSON: () => ({ e: axios() }) } }
}))
add('string-cause-toString-hostile', () => ({
  meta: {
    inner: new Error('o', {
      cause: {
        name: 'n',
        get message(): string {
          throw new Error('m')
        }
      }
    })
  }
}))
add('own-enum-cause-undefined', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: undefined }) }
}))
add('cmp-symbol-keyed-field', () => ({
  meta: { inner: Object.assign(new Error('s'), { [Symbol('hidden')]: 'symval' }) }
}))
add('cmp-proxy-passthrough', () => ({ meta: { inner: new Proxy(new Error('px'), {}) } }))
add('cmp-getter-field-ok', () => ({
  meta: {
    inner: Object.defineProperty(new Error('g'), 'ok', { enumerable: true, get: () => 'fine' })
  }
}))
add('cmp-toJSON-prototype', () => {
  class E extends Error {
    toJSON() {
      return { m: this.message }
    }
  }
  return { meta: { inner: new E('p') } }
})
add('cmp-toJSON-returns-error', () => ({
  meta: { inner: Object.assign(new Error('o'), { toJSON: () => new Error('ret') }) }
}))
add('cmp-root-toJSON-prototype', () => {
  class E extends Error {
    toJSON() {
      return { m: this.message }
    }
  }
  return { root: new E('rootp') }
})
add('cmp-class-field-cause', () => {
  class E extends Error {
    override cause = new Error('cf')
  }
  return { root: new E('c') }
})
add('cmp-class-field-held-secret', () => {
  class E extends Error {
    password = 'pw'
    held = new Error('h')
  }
  return { root: new E('c') }
})
add('cmp-aggregate', () => ({ meta: { inner: new AggregateError([new Error('a1')], 'agg') } }))
add('cmp-host-serializer-err-identity', () => ({
  root: new Error('hs'),
  extra: {
    serializers: { err: (e: unknown) => ({ seen: e instanceof Error, m: (e as Error).message }) }
  }
}))
add('cmp-host-serializer-err-shadow-key', () => ({
  root: new Error('hs2'),
  meta: { err: new Error('shadow') },
  extra: {
    serializers: { err: (e: unknown) => ({ seen: e instanceof Error, m: (e as Error).message }) }
  }
}))
add('cmp-key-error-without-serializer', () => ({ meta: { error: new Error('plain key') } }))
add('cmp-array-of-errors', () => ({ meta: { list: [new Error('l1'), new Error('l2')] } }))
add('cmp-enumerable-accessToken', () => ({
  meta: { inner: Object.assign(new Error('t'), { accessToken: 'zzz' }) }
}))
add('r5-enumerable-cause-axios', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: axios() }) }
}))
add('r5-aggregate-axios', () => ({ meta: { inner: new AggregateError([axios()], 'agg') } }))
add('r5-own-errors-map', () => ({
  meta: { inner: Object.assign(new Error('o'), { errors: { email: 'invalid' } }) }
}))
add('r5-own-errors-list', () => ({
  meta: { inner: Object.assign(new Error('o'), { errors: [{ path: 'a', message: 'bad' }] }) }
}))
add('r5-own-cause-object', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: { status: 500, detail: { x: 1 } } }) }
}))

/**
 * Shapes that are worse by decision, with the decision. A string `cause` is written like a
 * `message`, as the root `err` does, so a secret placed in one is as visible as one
 * placed in a message: secrets do not belong in either. An `Error` of another realm is the root
 * err as the error it is; the recorded base holds what it was read as before, `UnknownError` and
 * `[object Object]`, and those two values are the difference.
 */
const ACCEPTED: Record<string, RegExp> = {
  'cause-string': /^LEAK SECRET$/,
  'realm-root': /^LOST "UnknownError" "\[object Object\]"$/
}

describe('nested Error shapes, part B, against the 1.4.8 output', () => {
  if (process.env.RECORD_SHAPES) {
    it('records the output of this tree as the base', () => {
      const out = Object.fromEntries(Object.entries(cases).map(([name, make]) => [name, run(make)]))
      writeFileSync(process.env.RECORD_SHAPES as string, JSON.stringify(out, null, 1))
    })
    return
  }

  const base = loadBase('nested-error-shapes.b.base.json')

  it('has a recorded base for every shape and no base for a shape that is gone', () => {
    expect(Object.keys(base).sort()).toStrictEqual(Object.keys(cases).sort())
  })

  it.each(Object.keys(cases))('%s loses nothing and leaks nothing that 1.4.8 did not', (name) => {
    expect(judge(base[name], cases[name] as () => Shape)).toMatch(ACCEPTED[name] ?? /^$/)
  })
})
