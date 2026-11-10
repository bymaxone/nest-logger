/**
 * @fileoverview Jest setup that keeps a unit spec from opening a socket, in or out.
 * @layer scripts
 *
 * A unit spec drives the code with doubles and opens no socket. `listen` of `net.Server` is what
 * every server, `http` and Express included, ends in, and `connect` of `net.Socket` is what every
 * client ends in, `net.connect` and `fetch` included. A datagram socket opens at `bind` or `send`
 * of `dgram`, and its `connect` binds first. Replacing these stops a server, a connection or a
 * datagram socket however the method is reached: a variable key, a destructured or bound method,
 * the prototype itself. They are replaced only for a spec under `src/` and put back after the
 * file, because the core module is shared by every test file a Jest worker runs, and the
 * end-to-end specs under `test/e2e` start servers and call them.
 */
/* global expect, afterAll */
const dgram = require('node:dgram')
const net = require('node:net')
const path = require('node:path')

const SRC = path.resolve(__dirname, '..', 'src') + path.sep
/** The methods of a datagram socket that open it. */
const DATAGRAM = ['bind', 'send']
const { testPath } = expect.getState()

if (typeof testPath === 'string' && testPath.startsWith(SRC)) {
  const listen = net.Server.prototype.listen
  const connect = net.Socket.prototype.connect
  const datagram = Object.fromEntries(DATAGRAM.map((name) => [name, dgram.Socket.prototype[name]]))

  net.Server.prototype.listen = function refuseToListen() {
    throw new Error(
      'A unit spec opens no socket, so it cannot start a server. Use request and response ' +
        'doubles, or move the case to test/e2e.'
    )
  }
  net.Socket.prototype.connect = function refuseToConnect() {
    throw new Error(
      'A unit spec opens no socket, so it cannot connect to one. Use request and response ' +
        'doubles, or move the case to test/e2e.'
    )
  }

  for (const name of DATAGRAM) {
    dgram.Socket.prototype[name] = function refuseDatagram() {
      throw new Error(
        'A unit spec opens no socket, so it cannot open a datagram socket. Use doubles, or move ' +
          'the case to test/e2e.'
      )
    }
  }

  afterAll(() => {
    for (const name of DATAGRAM) dgram.Socket.prototype[name] = datagram[name]
    net.Server.prototype.listen = listen
    net.Socket.prototype.connect = connect
  })
}
