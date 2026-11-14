/**
 * @fileoverview A helper outside `src/` that loads `supertest` and uses it, for the spec that pins
 * the runtime guard.
 * @layer scripts
 *
 * The resolver refuses the package for a module under `src/` only, so a unit spec that goes
 * through a helper outside it is not stopped there. `supertest` starts the server it is given
 * with `listen`, which the setup of the guard replaces, when the request is sent and not when it
 * is built, so the helper sends it.
 */
const http = require('node:http')

/**
 * Load the package by name, ask it for a request against a fresh server and send it.
 *
 * @param {string} name - The package name, passed in so no selector can see it.
 * @returns {unknown} What the package answers.
 */
module.exports = function startRequest(name) {
  const test = require(name)(http.createServer()).get('/')
  test.end(() => undefined)
  return test
}
