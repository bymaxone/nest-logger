# Mutation Testing Plan — @bymax-one/nest-logger

> **Status:** Stryker installed, configured, and already run (first baseline: 2026-05-29).
> **Current score:** 97.42 % — passes `break: 95` gate ✅. Theoretical maximum given 10 documented equivalent mutants.
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

| Run                            | Date       | Score   | Notes                                                                                |
| ------------------------------ | ---------- | ------- | ------------------------------------------------------------------------------------ |
| Baseline                       | 2026-05-29 | 86 %    | First run, no hardening                                                              |
| After hardening                | 2026-05-29 | 95.93 % | 30 survivors killed; equivalents documented                                          |
| Intermediate (inline comments) | 2026-05-29 | 97.5 %  | `// Stryker disable` comments removed — exceeded 12 KiB server budget (now 13.5 KiB) |
| Genuine survivors eliminated   | 2026-06-18 | 97.42 % | 7 more survivors killed via targeted assertions; 10 equivalents left                 |

Current production score: **97.42 %** (exit 0, break gate passes). Theoretical maximum — see `mutation_testing_results.md §Residual survivors`.

---

## Theoretical maximum — 97.42 %

All 7 previously-identified `perTest` attribution artifacts have been killed (2026-06-18):

1. **HTTP interceptor 1xx boundary** — added a unit test instantiating `HttpLoggingInterceptor`
   directly with a mocked `ExecutionContext`, bypassing `supertest` entirely. Kills both
   `>= HTTP_SUCCESS_MIN` and `>= HTTP_REDIRECT_MIN` survivors simultaneously.

2. **`validate-options`** — added two dedicated tests for non-string `service.name` / `service.version`,
   and tightened the level error message regex to pin the `join(', ')` separator.

3. **`logger.module`** — added assertions on bootstrap message content and `error.cause` in
   `useNestLogger` error path.

The 10 remaining survivors are all documented equivalent mutants (see `mutation_testing_results.md
§Residual survivors`). **97.42 % is the theoretical maximum** for this codebase without
`// Stryker disable` inline comments (which would inflate the bundle past the 13.5 kB budget).

---

## Equivalent mutants — do NOT add `// Stryker disable` inline

The equivalent mutants are documented in `mutation_testing_results.md §Residual survivors`.
Do **not** annotate them with `// Stryker disable next-line` — those comments ship in the
unminified `.mjs` bundle (tsup `minify: false`) and will push the server subpath past its
13.5 KiB brotli budget. The documentation approach is the correct solution for this project.

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
