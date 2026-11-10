/**
 * Pins the runtime guard that keeps a unit spec from opening a socket, whatever way it spells it.
 * The lint gate names the spellings a selector can see; these cases use the ones it cannot (a name
 * built at run time, an aliased or destructured loader, `.call`, an interpolated template, a
 * dynamic `import()`, a method looked up by a variable), which only the resolution of the module
 * and the server's own `listen` can stop. A unit spec cannot load `supertest`, cannot start a
 * server, cannot connect out and cannot bind or send a datagram.
 *
 * Layer: repository tooling, tests. It imports nothing from `src/`; the guard itself is
 * `scripts/jest-no-sockets.resolver.cjs` and `scripts/jest-no-sockets.setup.cjs`, wired into the
 * Jest configurations that run unit specs.
 */
import { createSocket } from 'node:dgram'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createNetServer, Socket } from 'node:net'
import { resolve } from 'node:path'

/** The name of the package, built at run time so no selector can see it. */
const PACKAGE = ['super', 'test'].join('')

/** What both halves of the guard say, so a failure names what the unit spec should do instead. */
const REFUSED = /unit spec opens no socket/i

describe('the runtime guard against sockets in a unit spec', () => {
  describe('loading supertest', () => {
    it.each([
      ['a name built at run time', () => require(PACKAGE)],
      ['an interpolated template', () => require(`${'super'}test`)],
      ['a subpath', () => require(`${PACKAGE}/lib/agent`)],
      [
        'a loader aliased from jest',
        () => (jest.requireActual as (name: string) => unknown)(PACKAGE)
      ],
      [
        'a loader destructured from jest',
        () => {
          const { requireActual } = jest
          return requireActual(PACKAGE)
        }
      ],
      ['a loader called through .call', () => jest.requireActual.call(jest, PACKAGE)],
      ['a mock loader', () => jest.requireMock(PACKAGE)]
    ])('is refused for %s', (_name, load) => {
      expect(load).toThrow(REFUSED)
    })

    it('is refused for a dynamic import', async () => {
      await expect(import(PACKAGE)).rejects.toThrow(REFUSED)
    })
  })

  describe('a helper outside src/', () => {
    it('is refused when it loads supertest and starts a request, by the server that cannot listen', () => {
      // The resolver keys on the module that asks, and this one is outside `src/`: what stops the
      // request is the replaced `listen`, not the stub of the package.
      const helper = resolve(__dirname, '..', 'scripts', 'jest-no-sockets.fixture.cjs')
      const startRequest = require(helper) as (name: string) => unknown

      expect(() => startRequest(PACKAGE)).toThrow(REFUSED)
    })
  })

  describe('connecting out', () => {
    it('is refused for a socket, the method looked up by a variable', () => {
      const METHOD = ['conn', 'ect'].join('')
      const socket = new Socket()

      expect(() =>
        Reflect.get(socket, METHOD).call(socket, { port: 9, host: '127.0.0.1' })
      ).toThrow(REFUSED)
    })

    it('is refused for net.connect', () => {
      expect(() => connect({ port: 9, host: '127.0.0.1' })).toThrow(REFUSED)
    })

    it('is refused for fetch, whose connection fails with the reason as its cause', async () => {
      const failure = await fetch('http://127.0.0.1:59999/').then(
        () => undefined,
        (error: unknown) => error
      )

      expect(
        String((failure as { cause?: { message?: string } } | undefined)?.cause?.message)
      ).toMatch(REFUSED)
    })
  })

  describe('a datagram socket', () => {
    it.each(['bind', 'send', 'connect'])(
      'is refused for %s, the method looked up by a variable',
      (name) => {
        const socket = createSocket('udp4')
        const method = Reflect.get(socket, name) as (this: unknown, ...args: unknown[]) => unknown

        try {
          expect(() => method.call(socket, 59998, '127.0.0.1')).toThrow(REFUSED)
        } finally {
          socket.close()
        }
      }
    )
  })

  describe('starting a server', () => {
    const METHOD = ['lis', 'ten'].join('')

    it.each([
      ['a net server, the method looked up by a variable', () => createNetServer()],
      ['an http server, the method looked up by a variable', () => createHttpServer()]
    ])('is refused for %s', (_name, make) => {
      const server = make()

      expect(() => Reflect.get(server, METHOD).call(server, 0)).toThrow(REFUSED)
      expect(server.listening).toBe(false)
    })

    it('is refused for the method taken off the prototype', () => {
      const take = Reflect.get(createNetServer().constructor.prototype, METHOD) as (
        this: unknown,
        port: number
      ) => unknown

      expect(() => take.call(createHttpServer(), 0)).toThrow(REFUSED)
    })
  })
})
