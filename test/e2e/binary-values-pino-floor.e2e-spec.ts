/**
 * E2E: binary values that reach a line, on the oldest Pino the peer range admits.
 *
 * Layer: e2e, server. The redaction composes with members of Pino, so the floor runs the same rows;
 * `pino-floor` is an alias of `pino@10.0.0`.
 */
import pino from 'pino'

import { describeBinaryValues } from './support/binary-values.rows'

jest.mock('pino', () => jest.requireActual<typeof import('pino')>('pino-floor'))

it('runs these rows on Pino 10.0.0', () => {
  expect(pino.version).toBe('10.0.0')
})

describeBinaryValues('pino 10.0.0')
