/**
 * Shapes of a nested `Error`, part A: each is logged through the real pipeline and judged
 * against the entry 1.4.8 wrote for the same shape (`__tests__/nested-error-shapes.a.base.json`).
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

import { axios, judge, loadBase, run, type Shape } from './__tests__/nested-error-shapes.runner'

const cases: Record<string, () => Shape> = {}
const add = (name: string, make: () => any): void => {
  cases[name] = make
}

add('cause-std-axios', () => ({ meta: { inner: new Error('o', { cause: axios() }) } }))
add('cause-enum-axios', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: axios() }) }
}))
add('agg-axios', () => ({ meta: { inner: new AggregateError([axios()], 'agg') } }))
add('root-cause-axios', () => ({ root: new Error('o', { cause: axios() }), meta: {} }))
add('own-field-axios', () => ({
  meta: { inner: Object.assign(new Error('o'), { wrapped: axios() }) }
}))
add('cause-string', () => ({ meta: { inner: new Error('o', { cause: 'Bearer SECRETSTR' }) } }))
add('cause-obj-toString', () => ({
  meta: { inner: new Error('o', { cause: { toString: () => 'Bearer TOSTR', password: 'p' } }) }
}))
add('cause-plain-toJSON', () => ({
  meta: {
    inner: new Error('o', {
      cause: { name: 'n', message: 'm', toJSON: () => ({ a: 1 }), secretish: 'zzz' }
    })
  }
}))
add('enum-cause-plain-secret', () => ({
  meta: {
    inner: Object.assign(new Error('o'), { cause: { name: 'n', message: 'm', password: 'PW' } })
  }
}))
add('enum-cause-plain-nonerror', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: { a: 1, b: { password: 'PW' } } }) }
}))
add('enum-cause-string', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: 'plain string' }) }
}))
add('enum-cause-obj-info', () => ({
  meta: { inner: Object.assign(new Error('o'), { cause: { status: 500, detail: { x: 1 } } }) }
}))
add('enum-errors-nonerror', () => ({
  meta: { inner: Object.assign(new Error('o'), { errors: [{ a: 1 }, 'str'] }) }
}))
add('enum-errors-notarray', () => ({
  meta: { inner: Object.assign(new Error('o'), { errors: { a: 1 } }) }
}))
add('own-name-field', () => ({
  meta: { inner: Object.assign(new Error('o'), { name: 'Custom', extra: 1 }) }
}))
add('own-message-enumerable', () => ({
  meta: { inner: Object.assign(new Error('o'), { message: 'overridden' }) }
}))
add('own-stack-enum', () => ({
  meta: { inner: Object.assign(new Error('o'), { stack: 'STACK-secret=1' }) }
}))
add('type-field', () => ({ meta: { inner: Object.assign(new Error('o'), { type: 'mine' }) } }))
add('field-date-buffer-bigint', () => ({
  meta: {
    inner: Object.assign(new Error('o'), {
      d: new Date(0),
      b: Buffer.from('hi'),
      m: new Map([[1, 2]]),
      f() {},
      u: undefined,
      n: null
    })
  }
}))
add('field-depth', () => {
  let o: any = { v: 1 }
  for (let i = 0; i < 60; i++) o = { o }
  return { meta: { inner: Object.assign(new Error('o'), { deep: o }) } }
})
add('field-array-error', () => ({
  meta: { inner: Object.assign(new Error('o'), { list: [new Error('a'), new Error('b')] }) }
}))
add('stack-undefined', () => {
  const e = new Error('o')
  ;(e as any).stack = undefined
  return { meta: { inner: e } }
})
add('stack-nonstring', () => {
  const e = new Error('o')
  Object.defineProperty(e, 'stack', { value: 42 })
  return { meta: { inner: e } }
})
add('stack-node_modules', () => {
  const e = new Error('o')
  e.stack = 'Error: o\n at a (/x/node_modules/y.js)\n at b (/app/z.js)\x1b[31m'
  return { meta: { inner: e } }
})
add('message-nonstring', () => {
  const e: any = new Error('o')
  e.message = 42
  return { meta: { inner: e } }
})
add('name-nonstring', () => {
  const e: any = new Error('o')
  e.name = undefined
  return { meta: { inner: e } }
})
add('name-prototype-obj', () => {
  const e: any = new Error('o')
  Object.setPrototypeOf(e, null)
  return { meta: { inner: e } }
})
add('proto-null-error', () => {
  const e = Object.create(Error.prototype)
  return { meta: { inner: e } }
})
add('sym-secret', () => ({
  meta: {
    inner: Object.assign(new Error('o'), { [Symbol('s')]: 'SYMSECRET', [Symbol.toStringTag]: 'X' })
  }
}))
add('sym-error', () => ({
  meta: { inner: Object.assign(new Error('o'), { [Symbol('s')]: new Error('symerr') }) }
}))
add('toPrimitive', () => ({
  meta: {
    inner: Object.assign(new Error('o'), {
      [Symbol.toPrimitive]: () => {
        throw new Error('tp')
      }
    })
  }
}))
add('toStringTag', () => {
  const e: any = new Error('o')
  Object.defineProperty(e, Symbol.toStringTag, {
    get() {
      throw new Error('t')
    }
  })
  return { meta: { inner: e } }
})
add('toJSON-proto', () => {
  class A extends Error {
    toJSON() {
      return { z: 1 }
    }
  }
  return { meta: { inner: new A('x') } }
})
add('toJSON-own', () => ({
  meta: { inner: Object.assign(new Error('x'), { toJSON: () => ({ z: 1 }) }) }
}))
add('toJSON-getter', () => ({
  meta: { inner: Object.defineProperty(new Error('x'), 'toJSON', { get: () => () => ({ z: 2 }) }) }
}))
add('toJSON-getter-throw', () => ({
  meta: {
    inner: Object.defineProperty(new Error('x'), 'toJSON', {
      get() {
        throw new Error('g')
      }
    })
  }
}))
add('toJSON-throws', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      toJSON() {
        throw new Error('tj')
      }
    })
  }
}))
add('toJSON-returns-error', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      toJSON: () => new Error('ret', { cause: new Error('rc') })
    })
  }
}))
add('toJSON-returns-self', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      toJSON() {
        return this
      }
    })
  }
}))
add('toJSON-returns-error-w-secret', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      toJSON: () => Object.assign(new Error('r'), { password: 'PW', cause: axios() })
    })
  }
}))
add('toJSON-under-err-key', () => ({
  meta: { err: Object.assign(new Error('x'), { toJSON: () => ({ z: 1 }) }) }
}))
add('toJSON-root-err', () => ({
  root: Object.assign(new Error('x'), { toJSON: () => ({ z: 1 }) }),
  meta: {}
}))
add('toJSON-sensitive-key-src', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      password: 'p',
      toJSON() {
        return { v: this.password }
      }
    })
  }
}))
add('proxy-pass', () => ({ meta: { inner: new Proxy(new Error('px'), {}) } }))
add('proxy-get-throw', () => ({
  meta: {
    inner: new Proxy(new Error('px'), {
      get() {
        throw new Error('g')
      }
    })
  }
}))
add('proxy-has', () => ({
  meta: {
    inner: new Proxy(new Error('px'), {
      has() {
        throw new Error('h')
      }
    })
  }
}))
add('proxy-ownKeys', () => ({
  meta: {
    inner: new Proxy(new Error('px'), {
      ownKeys() {
        throw new Error('k')
      }
    })
  }
}))
add('proxy-ownKeys-secret', () => ({
  meta: { inner: new Proxy(Object.assign(new Error('px'), { a: 1 }), { ownKeys: () => [] }) }
}))
add('proxy-getProto', () => ({
  meta: {
    inner: new Proxy(new Error('px'), {
      getPrototypeOf() {
        throw new Error('p')
      }
    })
  }
}))
add('proxy-gopd', () => ({
  meta: {
    inner: new Proxy(Object.assign(new Error('px'), { a: 1 }), {
      getOwnPropertyDescriptor() {
        throw new Error('d')
      }
    })
  }
}))
add('proxy-get-secret-diff', () => {
  let n = 0
  return {
    meta: {
      inner: new Proxy(Object.assign(new Error('px'), { a: 1 }), {
        get(t, k, r) {
          if (k === 'a') return ++n % 2 ? 'ok' : { password: 'x', tok: 'LEAKP' }
          return Reflect.get(t, k, r)
        }
      })
    }
  }
})
add('proxy-root-err', () => ({
  root: new Proxy(new Error('px'), {
    get() {
      throw new Error('g')
    }
  }),
  meta: {}
}))
add('proxy-cause', () => ({
  meta: {
    inner: new Error('o', {
      cause: new Proxy(new Error('c'), {
        get() {
          throw new Error('g')
        }
      })
    })
  }
}))
add('proxy-in-bindings', () => ({
  child: {
    inner: new Proxy(new Error('px'), {
      get() {
        throw new Error('g')
      }
    })
  },
  meta: {}
}))
add('getter-diff', () => {
  let n = 0
  const e: any = new Error('o')
  Object.defineProperty(e, 'g', {
    enumerable: true,
    get() {
      return ++n === 1 ? 'first' : { token: 'LEAK2', note: 'x' }
    }
  })
  return { meta: { inner: e } }
})
add('getter-error', () => {
  const e: any = new Error('o')
  Object.defineProperty(e, 'g', {
    enumerable: true,
    get() {
      return new Error('got', { cause: new Error('cc') })
    }
  })
  return { meta: { inner: e } }
})
add('getter-throw', () => {
  const e: any = new Error('o')
  Object.defineProperty(e, 'g', {
    enumerable: true,
    get() {
      throw new Error('gt')
    }
  })
  e.keep = 'k'
  return { meta: { inner: e } }
})
add('getter-throw-root', () => {
  const e: any = new Error('o')
  Object.defineProperty(e, 'g', {
    enumerable: true,
    get() {
      throw new Error('gt')
    }
  })
  e.keep = 'k'
  return { root: e, meta: {} }
})
add('getter-cause', () => {
  const e: any = new Error('o')
  Object.defineProperty(e, 'cause', {
    enumerable: true,
    get() {
      throw new Error('gc')
    }
  })
  return { meta: { inner: e } }
})
add('getter-cause-diff', () => {
  let n = 0
  const e: any = new Error('o')
  Object.defineProperty(e, 'cause', {
    enumerable: true,
    get() {
      return ++n === 1
        ? new Error('c1')
        : Object.assign(new Error('c2'), { password: 'PWX', leakme: 'LEAKC' })
    }
  })
  return { meta: { inner: e } }
})
add('classfield-errors', () => {
  class E extends Error {
    errors = [new Error('e1', { cause: new Error('e1c') })]
  }
  return { meta: { inner: new E('x') } }
})
add('classfield-errors-root', () => {
  class E extends Error {
    errors = [new Error('e1', { cause: new Error('e1c') })]
  }
  return { root: new E('x'), meta: {} }
})

/**
 * Shapes that are worse by decision, with the decision. A string `cause` is written like a
 * `message`, as the root `err` does, so a secret placed in one is as visible as one
 * placed in a message: secrets do not belong in either. A nested Error's own `stack` text is
 * part of its node, as the root `err` writes it, so text planted there appears where 1.4.8
 * wrote `{}`.
 */
const ACCEPTED: Record<string, RegExp> = {
  'cause-string': /^LEAK SECRET$/,
  'own-stack-enum': /^LEAK STACK-secret$/
}

describe('nested Error shapes, part A, against the 1.4.8 output', () => {
  if (process.env.RECORD_SHAPES) {
    it('records the output of this tree as the base', () => {
      const out = Object.fromEntries(Object.entries(cases).map(([name, make]) => [name, run(make)]))
      writeFileSync(process.env.RECORD_SHAPES as string, JSON.stringify(out, null, 1))
    })
    return
  }

  const base = loadBase('nested-error-shapes.a.base.json')

  it('has a recorded base for every shape and no base for a shape that is gone', () => {
    expect(Object.keys(base).sort()).toStrictEqual(Object.keys(cases).sort())
  })

  it.each(Object.keys(cases))('%s loses nothing and leaks nothing that 1.4.8 did not', (name) => {
    expect(judge(base[name], cases[name] as () => Shape)).toMatch(ACCEPTED[name] ?? /^$/)
  })
})
