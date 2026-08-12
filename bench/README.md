# Throughput & allocation benchmark

`pnpm bench` measures the logger's hot path and **fails the process (exit 1) on a
throughput regression**, so a PR cannot silently degrade logging performance.
(Allocation is reported as an advisory signal only — see Budgets.)

## Scenarios

All four write to a no-op sink, so only the logging **pipeline** cost is
measured — never disk or TTY I/O.

| #     | Scenario                                                                                                                                                      | What it isolates            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **A** | bare Pino 10                                                                                                                                                  | baseline                    |
| **B** | `PinoLoggerService` (no redact, no mixin)                                                                                                                     | wrapper overhead            |
| **C** | **the shipped configuration** — `forRoot({ service })` with nothing else set: name-walk redaction + composed ALS/OTel mixin, inside an active request context | what consumers actually run |
| **D** | the same under the legacy `redactStrategy: 'paths'` escape hatch                                                                                              | cost of the old engine      |

Scenario **C** is the one that matters: it is what `BymaxLoggerModule.forRoot({ service })` builds with no option set. A gate that measured a configuration nobody runs would not be a gate.

## Budgets

Budgets are **relative** (scenario-vs-scenario), so they hold across machines
even though absolute ops/sec vary. They are calibrated to the **latest measured
baseline** (see Calibration history), not to aspirational targets:

- **Throughput (HARD gate):** `C.opsPerSec ≥ B.opsPerSec × 0.20`. The shipped
  path measures **0.356×** of the bare wrapper, so the floor sits ~1.9× below the
  measurement — enough to survive runner noise, tight enough to fail on a real
  ~2× regression. This is the only budget that fails CI.
- **Scenario D is printed, never gated.** It keeps the legacy strategy's cost
  visible and reproducible (the README quotes the comparison); constraining it
  would be constraining an escape hatch nobody should be reaching for.
- **Allocation (ADVISORY only):** `B.bytesPerOp ≤ A.bytesPerOp × 2.0`. The wrapper
  allocates ≈ 1.2× bare Pino locally, but `heapUsed` deltas are dominated by GC
  timing on shared CI runners (observed > 40× for identical code — pure noise),
  so allocation is **printed but never fails CI**.

### The redaction cliff, and why it is gone

When this bench was first run it showed the production path at **≈ 0.8 %** of the
bare wrapper, and the conclusion recorded here was that this was "the security
tax, not a defect". That conclusion was wrong, and the numbers are what showed it.

**`pino.multistream` was never the bottleneck** (it benchmarks as fast as bare
Pino) and the composed mixin costs ~14 %. The entire cliff was **path-based**
redaction: the default set expanded 27 field names into 108 multi-level
`fast-redact` wildcards, and `fast-redact` walks every key at every listed level
on every log. Cost grew with the PATH COUNT, not the payload — measured per
wildcard depth:

| default set                        |   ops/s |
| ---------------------------------- | ------: |
| no redaction, no mixin             | 662,967 |
| mixin only                         | 572,380 |
| exact paths only, no wildcards     | 551,974 |
| + wildcard depth 1                 |  54,317 |
| + depths 1–2                       |  22,302 |
| + depths 1–4 (the shipped default) |   9,286 |

Each wildcard level cost ~2.5×. Replacing the path list with a single
walk keyed on field NAME made the shipped path **~31× faster** (9,311 → 293,782)
and removed the four-level ceiling that had been leaking anything nested deeper.
The tax was in the strategy, not in redaction.

### Calibration history

- **2026-08-12** — name-walk redactor lands. C: 9,311 → 462,208 ops/s at first. Throughput
  floor raised 0.004 → **0.20**; the old floor could no longer fail on anything
  short of a 100× regression. Then PR review found a time-of-check/time-of-use
  window — a clean subtree returned by reference let `JSON.stringify` re-evaluate
  its accessors, and a stateful getter can answer differently the second time.
  Closing it means snapshotting every value instead: **C settles at 293,782 ops/s**
  (0.356× retention), a ~21 % trade for an output that is guaranteed to be what
  was inspected. Still ~37× the legacy `'paths'` engine (7,927 ops/s).
- **v0.1** — original baseline. The spec's budgets (10 % allocation / 5 %
  throughput) assumed redaction was cheap; the bench disproved it and the floor
  was dropped to 0.004 to match the wildcard engine.

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
a **throughput** regression (allocation is advisory-only).
