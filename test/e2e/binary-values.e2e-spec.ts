/**
 * E2E: binary values that reach a line through the raw logger.
 *
 * Layer: e2e, server. The rows live in the support file, which the Pino floor spec runs too.
 */
import { describeBinaryValues } from './support/binary-values.rows'

describeBinaryValues('the Pino of the project')
