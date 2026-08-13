/**
 * P1 feature-cost benchmark.
 *
 * Isolates the per-entry cost of each field P1 added, against the same shipped
 * configuration the main throughput benchmark measures. Run under Node 24:
 *
 *   node --expose-gc --import tsx bench/p1-features.bench.ts
 *
 * Every scenario logs the SAME structured entry through a real Pino instance
 * writing to a sink that discards, so the numbers isolate the logger rather than
 * the transport.
 */
import { applyDefaults } from '../src/server/config/default-options'
import type { BymaxLoggerModuleOptions } from '../src/server/interfaces/logger-module-options.interface'
import { buildPinoInstance } from '../src/server/pino-factory'
import { LogContextService } from '../src/server/services/log-context.service'
import { PinoLoggerService } from '../src/server/services/pino-logger.service'

/** Iterations per scenario; large enough to swamp JIT warm-up noise. */
const ITERATIONS = 200_000

/** A sink that costs as little as possible, so the logger is what is measured. */
const SINK = { name: 'null', write: (): void => {} }

const SERVICE = { name: 'checkout-api', version: '2.14.3' }

/** Build a logger for one configuration. */
function makeLogger(overrides: Partial<BymaxLoggerModuleOptions>): PinoLoggerService {
  const options = applyDefaults({ service: SERVICE, ...overrides } as BymaxLoggerModuleOptions)
  return new PinoLoggerService(buildPinoInstance(options, new LogContextService(), [SINK]))
}

/** Measure ops/sec for one scenario. */
function measure(label: string, logger: PinoLoggerService, withError: boolean): void {
  const error = new Error('card declined')
  error.name = 'PaymentDeclined'
  // Warm-up: let the JIT settle before the measured window.
  for (let i = 0; i < 20_000; i++) {
    if (withError) logger.errorStructured('PAYMENT_FAILED', error)
    else logger.info('PAYMENT_FAILED', 'Payment failed')
  }
  globalThis.gc?.()
  const start = process.hrtime.bigint()
  for (let i = 0; i < ITERATIONS; i++) {
    if (withError) logger.errorStructured('PAYMENT_FAILED', error)
    else logger.info('PAYMENT_FAILED', 'Payment failed')
  }
  const elapsedNs = Number(process.hrtime.bigint() - start)
  const opsPerSec = Math.round((ITERATIONS / elapsedNs) * 1e9)
  const usPerOp = elapsedNs / ITERATIONS / 1000
  console.log(`| ${label} | ${opsPerSec.toLocaleString('en-US')} | ${usPerOp.toFixed(2)} |`)
}

console.log('| Scenario | ops/sec | µs/log |')
console.log('| --- | ---: | ---: |')
measure('P1 shipped default', makeLogger({}), false)
measure('P1 without event.name', makeLogger({ eventNameField: false }), false)
measure('P1 flat resource format', makeLogger({ resourceFormat: 'flat' }), false)
measure(
  'P1 full resource identity',
  makeLogger({
    service: {
      ...SERVICE,
      namespace: 'payments',
      instanceId: 'pod-7f3a',
      environment: 'production'
    }
  }),
  false
)
measure('P1 error, legacy format', makeLogger({}), true)
measure('P1 error, errorFormat both', makeLogger({ errorFormat: 'both' }), true)
measure('P1 error, errorFormat semconv', makeLogger({ errorFormat: 'semconv' }), true)
