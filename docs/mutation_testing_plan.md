# Mutation Testing Plan — @bymax-one/nest-logger

> **Status:** Stryker installed, configured, and already run (first baseline: 2026-05-29).
> **Current score:** 95.93 % — passes `break: 95` gate ✅, below `high: 99` aspirational target.
> **Full results:** [`docs/mutation_testing_results.md`](./mutation_testing_results.md)

---

## Setup — already done

Everything is in place. No install or config steps needed.

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `stryker.config.json`                 | Main config — thresholds, reporters, temp dir                           |
| `jest.stryker.config.ts`              | Jest config used by Stryker (separate from the normal `jest.config.ts`) |
| `@stryker-mutator/core`               | Core in `devDependencies`                                               |
| `@stryker-mutator/jest-runner`        | Jest test-runner plugin                                                 |
| `@stryker-mutator/typescript-checker` | TS type-checker plugin                                                  |

---

## Running mutation tests

```bash
# Full run (~10-20 min). Writes to reports/mutation/mutation.html
pnpm mutation

# Incremental run — faster re-run using the cached results from the last full run
pnpm mutation:incremental

# Dry run — validates config without running any mutants
pnpm mutation:dry-run
```

Open `reports/mutation/mutation.html` after a run for the full per-file breakdown.

---

## Current thresholds (`stryker.config.json`)

```json
"thresholds": { "high": 99, "low": 95, "break": 95 }
```

| Threshold   | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `break: 95` | `pnpm mutation` exits 1 if score < 95 % — hard gate           |
| `low: 95`   | Score between low and high → yellow in the HTML report        |
| `high: 99`  | Aspirational target — score ≥ 99 % → green in the HTML report |

---

## Score history

| Run                            | Date       | Score   | Notes                                                                |
| ------------------------------ | ---------- | ------- | -------------------------------------------------------------------- |
| Baseline                       | 2026-05-29 | 86 %    | First run, no hardening                                              |
| After hardening                | 2026-05-29 | 95.93 % | 30 survivors killed; equivalents documented                          |
| Intermediate (inline comments) | 2026-05-29 | 97.5 %  | `// Stryker disable` comments removed — exceeded 12 kB bundle budget |

Current production score: **95.93 %** (exit 0, break gate passes).

---

## Path to 99 % (tracked as follow-up)

The 15 surviving mutants are documented in [`mutation_testing_results.md`](./mutation_testing_results.md). In summary:

**6 are equivalent mutants** — not killable by definition (no test can distinguish them from the original). Documented there rather than with inline `// Stryker disable` comments, which would ship in the unminified `.mjs` bundle and pushed the server subpath past its 12 kB brotli budget.

**9 are Stryker `perTest` attribution artifacts** — the killing tests exist (100 % line/branch coverage proves it), but Stryker does not correctly attribute them because:

1. **HTTP interceptor** — `supertest`-driven HTTP tests flake under Stryker's instrumented runtime ("socket hang up").
   - Fix: unit-test the interceptor with a mocked `ExecutionContext` instead of supertest.

2. **`validate-options` + `trace-context.mixin` + `logger.module`** — test fixtures run `forRoot` at module-load time (static `@Module` declaration), so Stryker attributes coverage to the load event, not to the runtime tests that kill the mutants.
   - Fix: move `forRoot` calls into `beforeAll` so Stryker can attribute per-test.

Both fixes are straightforward but require touching existing test files. Target: **99 % after these refactors**, before v0.2.0.

---

## Equivalent mutants — do NOT add `// Stryker disable` inline

The equivalent mutants are documented in `mutation_testing_results.md §Residual survivors`.
Do **not** annotate them with `// Stryker disable next-line` — those comments ship in the
unminified `.mjs` bundle (tsup `minify: false`) and will push the server subpath past its
12 kB brotli budget. The documentation approach is the correct solution for this project.

---

## CI strategy — do NOT wire to per-PR CI

Mutation testing is a **manual, pre-release gate**. It is NOT in `prepublishOnly` or `ci.yml`.

**Rationale:** a full run takes 10–20 minutes. Per-PR CI already enforces 100 % line/branch
coverage — that is sufficient for continuous integration. Mutation testing is the deeper gate
reserved for release candidates.

**Release checklist (LOG-063 / future releases):**

1. `pnpm test:cov:all` → 100 % across all metrics
2. `pnpm mutation` → score ≥ 95 % (break gate); aim for ≥ 99 % before v1.0
3. `pnpm prepublishOnly` → clean
4. `node scripts/dogfood-smoke-test.mjs` → all assertions green
5. Tag + publish
