/**
 * E2E: objects that reach the message of an entry, on the newest Pino 10 the repository installs.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, the Pino factory, the redaction walk).
 */
import pino from 'pino'

import { describeMessageValues } from './support/message-values.rows'

it('runs these rows on Pino 10.4.0', () => {
  expect(pino.version).toBe('10.4.0')
})

describeMessageValues('pino 10.4.0')
