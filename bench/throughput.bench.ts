/**
 * Throughput + allocation benchmark guarding the logger's hot path against
 * accidental regressions.
 *
 * Three scenarios, all writing to a no-op sink so only the logging PIPELINE cost
 * is measured (never disk/tty I/O):
 *
 *   A — bare Pino 10                      (baseline)
 *   B — PinoLoggerService, no redact/mixin (wrapper overhead)
 *   C — PinoLoggerService + 97 redact paths + composed ALS/OTel mixin (prod path)
 *
 * Gates — calibrated to the measured v0.1 baseline (see bench/README.md):
 *   - C ops/sec ≥ B ops/sec × 0.004 — the HARD gate. The 97 wildcard redact
 *     paths are the dominant prod cost (~30µs/op), so the prod path runs at
 *     ~0.8% of the bare wrapper; this floor catches a further ~2× regression.
 *   - B allocated ≤ A allocated × 2.0 — ADVISORY only (printed, never fails CI).
 *     heapUsed deltas are dominated by GC timing on shared CI runners (~1.2×
 *     locally vs >40× on a GitHub runner for identical code — pure sampling
 *     noise), so allocation cannot gate CI reliably.
 *
 * Finding: `pino.multistream` is NOT a bottleneck (≈ bare Pino); the throughput
 * cliff is wildcard PII redaction. The wrapper itself is nearly free.
 *
 * Run with `pnpm bench`. Allocation accuracy improves under `--expose-gc`
 * (`pnpm bench` wires it); without it the GC is simply not forced between
 * samples. Reproducible: fixed payload, fixed warmup, no RNG.
 */
import { Writable } from 'node:stream'

import pino from 'pino'
import { Bench } from 'tinybench'

import { applyDefaults } from '../src/server/config/default-options'
import type { ILogDestination } from '../src/server/interfaces/log-destination.interface'
import { buildPinoInstance } from '../src/server/pino-factory'
import { LogContextService } from '../src/server/services/log-context.service'
import { PinoLoggerService } from '../src/server/services/pino-logger.service'

/** Allocation overhead budget: wrapper (B) vs bare Pino (A). Baseline ≈ 1.2×. */
const ALLOCATION_BUDGET = 2.0
/** Throughput-retention budget: prod path (C) vs wrapper (B). Baseline ≈ 0.008×. */
const THROUGHPUT_BUDGET = 0.004
/** Iterations used for the allocation probe. */
const ALLOC_ITERATIONS = 50_000

/** ~200-byte structured payload, fixed for reproducibility. */
const PAYLOAD = Object.freeze({
  orderId: 'ord_4bf92f3577b34da6',
  amount: 1299,
  currency: 'BRL',
  items: 3,
  channel: 'web-checkout',
  note: 'benchmark fixture payload kept around two hundred bytes for realism'
})

/** Discards every write — isolates pipeline cost from I/O. */
const devNull = new Writable({
  write(_chunk, _encoding, callback): void {
    callback()
  }
})

/** A destination that drops every entry (for the multistream prod path). */
const devNullDestination: ILogDestination = { name: 'devnull', write: (): void => undefined }

const bareLogger = pino({ level: 'info' }, devNull)

const wrapperLogger = new PinoLoggerService(pino({ level: 'info' }, devNull))

const logContext = new LogContextService()
const prodLogger = new PinoLoggerService(
  buildPinoInstance(applyDefaults({ service: { name: 'bench', version: '1.0.0' } }), logContext, [
    devNullDestination
  ])
)

/** Bare-Pino call (scenario A). */
function runBare(): void {
  bareLogger.info({ logKey: 'BENCH_EVENT_OK', userId: 'u_1', ...PAYLOAD }, 'bench')
}

/** Wrapper-only call (scenario B). */
function runWrapper(): void {
  wrapperLogger.info('BENCH_EVENT_OK', 'bench', 'u_1', PAYLOAD)
}

/** Full prod path: redact + mixin, inside an active request context (scenario C). */
function runProd(): void {
  logContext.run({ requestId: 'r_1', tenantId: 't_1' }, () =>
    prodLogger.info('BENCH_EVENT_OK', 'bench', 'u_1', {
      ...PAYLOAD,
      password: 'secret',
      token: 'x'
    })
  )
}

/**
 * Approximate bytes allocated per call by sampling `heapUsed` deltas across a
 * fixed iteration count, forcing GC first when `--expose-gc` is available.
 *
 * @param fn - The call to measure.
 * @returns Estimated bytes allocated per invocation (never negative).
 */
function bytesPerOp(fn: () => void): number {
  global.gc?.()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < ALLOC_ITERATIONS; i++) {
    fn()
  }
  const after = process.memoryUsage().heapUsed
  return Math.max(0, after - before) / ALLOC_ITERATIONS
}

/** Format a number with thousands separators and no fractional noise. */
function fmt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

async function main(): Promise<void> {
  const bench = new Bench({ time: 1500, warmupTime: 300 })
  bench
    .add('A: bare pino', runBare)
    .add('B: PinoLoggerService', runWrapper)
    .add('C: prod path', runProd)
  await bench.run()

  // tinybench v6 replaced the scalar `result.hz` with a `throughput` Statistics
  // object whose `mean` is the ops/sec equivalent. Narrow the result union with
  // `in` so a not-started / errored task safely yields 0 instead of a type error.
  const ops = (name: string): number => {
    const result = bench.tasks.find((task) => task.name === name)?.result
    return result && 'throughput' in result ? result.throughput.mean : 0
  }
  const aOps = ops('A: bare pino')
  const bOps = ops('B: PinoLoggerService')
  const cOps = ops('C: prod path')

  const aAlloc = bytesPerOp(runBare)
  const bAlloc = bytesPerOp(runWrapper)
  const cAlloc = bytesPerOp(runProd)

  const allocRatio = aAlloc === 0 ? 0 : bAlloc / aAlloc
  const throughputRatio = bOps === 0 ? 0 : cOps / bOps

  process.stdout.write('\n| Scenario | ops/sec | bytes/op |\n')
  process.stdout.write('| --- | ---: | ---: |\n')
  process.stdout.write(`| A: bare pino | ${fmt(aOps)} | ${fmt(aAlloc)} |\n`)
  process.stdout.write(`| B: PinoLoggerService | ${fmt(bOps)} | ${fmt(bAlloc)} |\n`)
  process.stdout.write(`| C: prod path (redact+mixin) | ${fmt(cOps)} | ${fmt(cAlloc)} |\n\n`)
  process.stdout.write(
    `Allocation overhead (B/A): ${allocRatio.toFixed(3)}× (budget ≤ ${ALLOCATION_BUDGET}×)\n`
  )
  process.stdout.write(
    `Throughput retention (C/B): ${throughputRatio.toFixed(3)}× (budget ≥ ${THROUGHPUT_BUDGET}×)\n`
  )
  if (!global.gc) {
    process.stdout.write('Note: run with --expose-gc for accurate allocation numbers.\n')
  }

  const allocWithinGuideline = allocRatio <= ALLOCATION_BUDGET
  const throughputOk = throughputRatio >= THROUGHPUT_BUDGET
  if (!allocWithinGuideline) {
    // Advisory only — heapUsed sampling is too noisy on shared runners to gate CI.
    process.stdout.write(
      `\nNOTE (advisory, non-blocking): allocation overhead ${allocRatio.toFixed(3)}× exceeds the ${ALLOCATION_BUDGET}× guideline — likely heapUsed sampling noise.\n`
    )
  }
  if (!throughputOk) {
    process.stderr.write(
      `\nREGRESSION: throughput retention ${throughputRatio.toFixed(3)}× below ${THROUGHPUT_BUDGET}×\n`
    )
  }
  process.exit(throughputOk ? 0 : 1)
}

void main()
