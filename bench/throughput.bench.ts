/**
 * Throughput + allocation benchmark guarding the logger's hot path against
 * accidental regressions.
 *
 * Four scenarios, all writing to a no-op sink so only the logging PIPELINE cost
 * is measured (never disk/tty I/O):
 *
 *   A — bare Pino 10                       (baseline)
 *   B — PinoLoggerService, no redact/mixin  (wrapper overhead)
 *   C — THE SHIPPED CONFIGURATION: PinoLoggerService + default name-walk
 *       redaction + composed ALS/OTel mixin, inside an active request context
 *   D — the same, with the legacy `redactStrategy: 'paths'` escape hatch
 *
 * Scenario C is what `BymaxLoggerModule.forRoot({ service })` actually builds,
 * with no option set — the point of this bench is that the gate measures what
 * the package distributes, not a configuration nobody runs.
 *
 * Gates:
 *   - C ops/sec ≥ B ops/sec × 0.20 — the HARD gate. Redaction is now a single
 *     O(nodes) walk, so the shipped path retains most of the bare wrapper's
 *     throughput; this floor catches roughly a 2× regression while leaving room
 *     for the noise of a shared CI runner. It replaces a 0.004 floor that was
 *     calibrated to the old wildcard-path engine and had stopped meaning
 *     anything: a 100× slowdown could pass it.
 *   - D is measured and PRINTED but never gated. It exists to keep the cost of
 *     the legacy strategy visible and reproducible — the README quotes this
 *     comparison — not to constrain it.
 *   - B allocated ≤ A allocated × 2.0 — ADVISORY only (printed, never fails CI).
 *     heapUsed deltas are dominated by GC timing on shared CI runners (~1.2×
 *     locally vs >40× on a GitHub runner for identical code — pure sampling
 *     noise), so allocation cannot gate CI reliably.
 *
 * Finding, and the reason the engine changed: `pino.multistream` is NOT a
 * bottleneck (≈ bare Pino) and the mixin costs ~14%. The throughput cliff was
 * wildcard PII redaction — 108 multi-level `fast-redact` paths at ~107 µs/op.
 * Scenario D still measures it.
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
import { DestinationHealth } from '../src/server/services/destination-health.service'
import { LogContextService } from '../src/server/services/log-context.service'
import { PinoLoggerService } from '../src/server/services/pino-logger.service'

/** Allocation overhead budget: wrapper (B) vs bare Pino (A). Baseline ≈ 1.2×. */
const ALLOCATION_BUDGET = 2.0
/**
 * Throughput-retention budget: SHIPPED path (C) vs wrapper (B).
 *
 * Measured 0.385× (462 k vs 1.20 M ops/s) on 2026-08-12 with the name-walk
 * redactor. The floor sits at ~1.9× of headroom below that — the same
 * calibration convention the bundle-size gate uses: tight enough to fail on a
 * real ~2× regression, loose enough to survive a shared CI runner.
 *
 * It replaces a 0.004 floor calibrated to the wildcard-path engine, which had
 * stopped gating anything: the shipped path measured 0.007× there, so a further
 * 75 % slowdown would still have passed.
 */
const THROUGHPUT_BUDGET = 0.2
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
// Nothing is ever marked failed here, so every destination counts as live —
// the benchmark measures the healthy write path, which is the one that runs in
// production.
const health = new DestinationHealth()
const prodLogger = new PinoLoggerService(
  buildPinoInstance(
    applyDefaults({ service: { name: 'bench', version: '1.0.0' } }),
    logContext,
    [devNullDestination],
    health
  )
)
const legacyLogger = new PinoLoggerService(
  buildPinoInstance(
    applyDefaults({ service: { name: 'bench', version: '1.0.0' }, redactStrategy: 'paths' }),
    logContext,
    [devNullDestination],
    health
  )
)

/** Bare-Pino call (scenario A). */
function runBare(): void {
  bareLogger.info({ logKey: 'BENCH_EVENT_OK', userId: 'u_1', ...PAYLOAD }, 'bench')
}

/** Wrapper-only call (scenario B). */
function runWrapper(): void {
  wrapperLogger.info('BENCH_EVENT_OK', 'bench', 'u_1', PAYLOAD)
}

/** The shipped configuration: default redaction + mixin, in a request context (C). */
function runProd(): void {
  logContext.run({ requestId: 'r_1', tenantId: 't_1' }, () =>
    prodLogger.info('BENCH_EVENT_OK', 'bench', 'u_1', {
      ...PAYLOAD,
      password: 'secret',
      token: 'x'
    })
  )
}

/** The same call under the legacy `redactStrategy: 'paths'` escape hatch (D). */
function runLegacy(): void {
  logContext.run({ requestId: 'r_1', tenantId: 't_1' }, () =>
    legacyLogger.info('BENCH_EVENT_OK', 'bench', 'u_1', {
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
    .add('C: shipped config', runProd)
    .add("D: legacy redactStrategy 'paths'", runLegacy)
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
  const cOps = ops('C: shipped config')
  const dOps = ops("D: legacy redactStrategy 'paths'")

  const aAlloc = bytesPerOp(runBare)
  const bAlloc = bytesPerOp(runWrapper)
  const cAlloc = bytesPerOp(runProd)
  const dAlloc = bytesPerOp(runLegacy)

  const allocRatio = aAlloc === 0 ? 0 : bAlloc / aAlloc
  const throughputRatio = bOps === 0 ? 0 : cOps / bOps

  process.stdout.write('\n| Scenario | ops/sec | bytes/op |\n')
  process.stdout.write('| --- | ---: | ---: |\n')
  process.stdout.write(`| A: bare pino | ${fmt(aOps)} | ${fmt(aAlloc)} |\n`)
  process.stdout.write(`| B: PinoLoggerService | ${fmt(bOps)} | ${fmt(bAlloc)} |\n`)
  process.stdout.write(
    `| C: shipped config (name redact + mixin) | ${fmt(cOps)} | ${fmt(cAlloc)} |\n`
  )
  process.stdout.write(`| D: legacy 'paths' strategy | ${fmt(dOps)} | ${fmt(dAlloc)} |\n\n`)
  process.stdout.write(
    `Allocation overhead (B/A): ${allocRatio.toFixed(3)}× (budget ≤ ${ALLOCATION_BUDGET}×)\n`
  )
  process.stdout.write(
    `Throughput retention (C/B): ${throughputRatio.toFixed(3)}× (budget ≥ ${THROUGHPUT_BUDGET}×)\n`
  )
  process.stdout.write(
    `Name walk vs legacy paths (C/D): ${dOps === 0 ? 0 : (cOps / dOps).toFixed(1)}× faster (informational)\n`
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
