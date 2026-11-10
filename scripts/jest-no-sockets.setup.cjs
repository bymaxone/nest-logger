/**
 * @fileoverview Jest setup that keeps a unit spec from opening a socket, in or out.
 * @layer scripts
 *
 * A unit spec drives the code with doubles and opens no socket. `listen` of `net.Server` is what
 * every server, `http` and Express included, ends in, and `connect` of `net.Socket` is what every
 * client ends in, `net.connect` and `fetch` included, so replacing them stops a server or a
 * connection however the method is reached: a variable key, a destructured or bound method, the
 * prototype itself. They are replaced only for a spec under `src/` and put back after the file,
 * because the core module is shared by every test file a Jest worker runs, and the end-to-end
 * specs under `test/e2e` start servers and call them.
 */
/* global expect, afterAll */
const net = require('node:net')
const path = require('node:path')

const SRC = path.resolve(__dirname, '..', 'src') + path.sep
const { testPath } = expect.getState()

if (typeof testPath === 'string' && testPath.startsWith(SRC)) {
  const listen = net.Server.prototype.listen
  const connect = net.Socket.prototype.connect

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

  afterAll(() => {
    net.Server.prototype.listen = listen
    net.Socket.prototype.connect = connect
  })
}
