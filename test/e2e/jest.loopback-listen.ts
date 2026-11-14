/**
 * Binds every port-only `listen` of the end-to-end suite to the IPv4 loopback address.
 *
 * Layer: e2e support, loaded through `setupFilesAfterEnv` in `jest.e2e.config.ts` and in
 * `jest.coverage.config.ts`. The coverage config runs the unit specs too, which open no socket, so
 * the patch is installed for a spec under `test/e2e` only.
 *
 * The reasoning, the patch and its limits are in `test/e2e/support/loopback-listen.ts`.
 */
import { join } from 'node:path'

import { installLoopbackListen } from './support/loopback-listen'

const { testPath } = expect.getState()

if (typeof testPath === 'string' && testPath.startsWith(join(__dirname, '/'))) {
  installLoopbackListen()
}
