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
pnpm mutation:full        # cold — deletes the baseline first, measures the truth
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

## Suppression policy

An equivalent mutant — one no test can kill because the mutation preserves observable
behaviour — is documented **in the source**, on the line it applies to:

```ts
// Stryker disable next-line <Mutator>[,<Mutator>]: <why the mutant is equivalent>
```

The reason belongs next to the code it explains, where it cannot drift away from it. A
separate report can, and does: line references rot after a reformatting, and a report can
claim a score the branch no longer measures.

Four rules keep that documentation real rather than decorative:

- **The reason goes after the colon, on one line.** Stryker parses a directive with
  `/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/`. The mutator
  list accepts letters, commas and spaces only, and the reason is captured exclusively
  after the colon and only to the end of that line. Written after `--`, or wrapped onto a
  second comment line, the reason is silently dropped and the report shows Stryker's
  fallback text, `Ignored using a comment`.
- **A directive that does not attach uses the block form.** `next-line` does not reach a
  catch-clause body, a multi-line call argument, or anything inside a builder chain. Those
  take `// Stryker disable <Mutator>` … `// Stryker restore <Mutator>` around the whole
  statement.
- **The reason must be true.** Where a mutant is not equivalent but Stryker fails to
  attribute the killing test to it, the directive says exactly that. Calling it equivalent
  would be false, and a false justification is worth less than a lower score.
- **A mutant a test could kill is never disabled.** Strengthen the test instead. The break
  threshold is never lowered to accommodate a survivor.

`pnpm check:mutants` enforces the first rule mechanically, and also rejects a mutator name
Stryker does not know — which matches nothing, so the directive silences nothing while
looking like it does. Stryker warns about that case, but only during a mutation run, which
is too late to block the change that introduced it.

These comments ship in the unminified bundle. The measured cost is small — seven directives
cost 0.10 kB brotli in a server subpath of roughly 13 kB — because brotli compresses their
repeated prefixes almost for free. Where a bundle budget is genuinely tight, the budget is
raised deliberately in the same change with the measurement recorded beside it, rather than
the documentation being dropped: a budget exists to catch code bloat, and the reason a
mutant survives is not bloat.

This policy is identical across the `@bymax-one/nest-*` libraries.

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
