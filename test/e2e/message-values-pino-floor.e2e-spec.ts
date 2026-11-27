/**
 * E2E: objects that reach the message of an entry, on the oldest Pino the peer range admits.
 *
 * Layer: e2e, server. The redaction composes with two members Pino exposes through `symbols`, so
 * both ends of the range run the same rows; `pino-floor` is an alias of `pino@10.0.0`.
 */
import pino from 'pino'

import { describeMessageValues } from './support/message-values.rows'

jest.mock('pino', () => jest.requireActual<typeof import('pino')>('pino-floor'))

it('runs these rows on Pino 10.0.0', () => {
  expect(pino.version).toBe('10.0.0')
})

describeMessageValues('pino 10.0.0')
