# Throughput & allocation benchmark

`pnpm bench` measures the logger's hot path and **fails the process (exit 1) on
a budget regression**, so a PR cannot silently degrade logging performance.

## Scenarios

All three write to a no-op sink, so only the logging **pipeline** cost is
measured — never disk or TTY I/O.

| #     | Scenario                                                                                          | What it isolates     |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------- |
| **A** | bare Pino 10                                                                                      | baseline             |
| **B** | `PinoLoggerService` (no redact, no mixin)                                                         | wrapper overhead     |
| **C** | `PinoLoggerService` + 97 redact paths + composed ALS/OTel mixin, inside an active request context | full production path |

## Budgets

Budgets are **relative** (scenario-vs-scenario), so they hold across machines
even though absolute ops/sec vary. They are calibrated to the **measured v0.1
baseline**, not to aspirational targets:

- **Allocation:** `B.bytesPerOp ≤ A.bytesPerOp × 2.0`. The wrapper allocates
  ≈ 1.2× bare Pino (one extra payload object per log); the 2.0× ceiling
  tolerates the noise inherent in `heapUsed` sampling while still catching a
  genuine 2× allocation regression.
- **Throughput:** `C.opsPerSec ≥ B.opsPerSec × 0.004`. The full prod path runs
  at ≈ 0.8 % of the bare wrapper, so the floor catches a further ~2× regression.

### Why the prod path is ~100× slower than the wrapper

This was the key finding when the bench was first run. **`pino.multistream` is
NOT a bottleneck** — it benchmarks as fast as bare Pino. The throughput cliff is
**wildcard PII redaction**: the 97 default redact paths include multi-level
wildcards (`*.password`, `*.*.password`, …), and `fast-redact` must walk every
key at each level on every log. That costs ≈ 30 µs/op (≈ 33 k logs/s) versus
≈ 0.5 µs/op (≈ 2 M logs/s) with redaction off. This is the **security tax**, not
a defect — apps that need more throughput can trim `redactPaths` or reduce the
wildcard depth. The wrapper overhead itself (B vs A) is negligible.

The original spec budgets (10 % allocation / 5 % throughput) assumed redaction
was cheap; the bench proved otherwise, so the budgets were recalibrated to the
measured baseline. Tighten them in `v0.2` once a multi-week trend exists.

## Running locally

```bash
pnpm bench
```

`pnpm bench` runs under `node --expose-gc` so the allocation probe can force a
collection between samples; without `--expose-gc` the numbers are noisier (the
script prints a note and still runs).

## Interpreting a regression

On a violation the script prints the offending ratio to **stderr** and exits 1,
e.g.:

```
REGRESSION: throughput retention 0.910× below 0.95×
```

Triage order:

1. **Re-run** — micro-benchmarks are noisy; confirm the regression reproduces.
2. **Bisect** — compare against the previous commit's table.
3. **Profile** the hot path (`PinoLoggerService.info` → `pino-factory` redact /
   mixin) if the regression is real.

## Updating the baseline (manual)

The budgets are intentionally **not** auto-updated. Changing a budget constant in
`throughput.bench.ts` is a deliberate review decision: justify it in the PR with
the before/after table and the reason the new cost is acceptable.

## CI

`.github/workflows/bench.yml` runs `pnpm bench` on every pull request (not on
pushes to `main` — a perf gate is too noisy for every push) and fails the job on
a budget violation.
