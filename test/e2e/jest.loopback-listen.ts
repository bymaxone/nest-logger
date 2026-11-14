/**
 * Binds every port-only `listen` of the end-to-end suite to the IPv4 loopback address, and makes
 * supertest wait for a listener it starts itself.
 *
 * Layer: e2e support, loaded through `setupFilesAfterEnv` in `jest.e2e.config.ts` and in
 * `jest.coverage.config.ts`. The coverage config runs the unit specs too, which open no socket and
 * may not load supertest, so the patches are installed for a spec under `test/e2e` only.
 *
 * The reasoning, the patches and their limits are in `test/e2e/support/loopback-listen.ts`.
 */
import { join } from 'node:path'

const { testPath } = expect.getState()

if (typeof testPath === 'string' && testPath.startsWith(join(__dirname, '/'))) {
  // Required here and not imported above: the module loads supertest, which a unit spec may not.
  const { installLoopbackListen, installSupertestWait } =
    require('./support/loopback-listen') as typeof import('./support/loopback-listen')
  installLoopbackListen()
  installSupertestWait()
}
