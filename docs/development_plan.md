# Development Plan — @bymax-one/nest-logger

> **Version:** 2.0.0
> **Last updated:** 2026-06-18
> **Status:** ✅ COMPLETE — v1.0.0 published to npm on 2026-06-18
> **Reference spec:** [`docs/technical_specification.md`](./technical_specification.md)
> **Target engine:** Pino 10.x + OpenTelemetry SDK 1.x (optional)
> **Derived document:** `docs/development_tasks.md` (Layer 3 — generated from this plan)

---

## Table of Contents

1. [Plan Overview](#1-plan-overview)
2. [Phase 1 — Foundation + Pino Integration](#2-phase-1--foundation--pino-integration)
3. [Phase 2 — Context Propagation + OpenTelemetry Mixin](#3-phase-2--context-propagation--opentelemetry-mixin)
4. [Phase 3 — HTTP Interceptor + Filter + Decorators](#4-phase-3--http-interceptor--filter--decorators)
5. [Phase 4 — Pretty Destination + Custom Destinations + Testing Suite](#5-phase-4--pretty-destination--custom-destinations--testing-suite)
6. [Phase 5 — Release v0.1.0](#6-phase-5--release-v010)
7. [Appendix A — Dependency Graph](#appendix-a--dependency-graph)
8. [Appendix B — Complexity Matrix](#appendix-b--complexity-matrix)
9. [Appendix C — Reference Configs (mirror of nest-auth)](#appendix-c--reference-configs-mirror-of-nest-auth)
10. [Appendix D — Glossary and term mapping](#appendix-d--glossary-and-term-mapping)

---

## 1. Plan Overview

### 1.1 Development strategy

The implementation follows the **TDD red-green-refactor** protocol with vertically sliced phases:

- Every phase delivers **usable functionality** (not just "code done") — at the end of each phase, you can spin up the lib in a NestJS fixture app and exercise what was implemented
- **Tests precede implementation** in every file with non-trivial logic (services, utils, mixins, interceptors, filters, decorators)
- **Per-phase coverage gate**: 100% (statements/branches/functions/lines) — pattern inherited from `nest-auth` via `jest.coverage.config.ts`. Per-file inside the phase may dip below as long as the phase isn't closed, but the end gate is `pnpm test:cov:all = 100%`.
- **Mutation testing** runs as a **pre-release** gate only (not in per-commit CI — Stryker takes 10-20 min). Thresholds: `{ high: 99, low: 95, break: 95 }` — identical to `nest-auth`'s `stryker.config.json`. Final project acceptance: **mutation score ≥ 99%**.
- **Refactor pass** at the end of each phase, with `/bymax-quality:code-review` before marking the phase as done

The phase order respects the dependency graph (Appendix A): contracts before implementations, dynamic module after services, HTTP integrations after context propagation.

### 1.2 Guiding principles

| Principle                                                | Practical application                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TS strict, zero `any`**                                | Compiler in `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Single documented exception: NestJS `LoggerService` signatures (see spec §6.1). |
| **JSDoc on every exported symbol**                       | Every `export` of class, function, interface, constant carries JSDoc with `@example` when applicable.                                                                 |
| **English in code and comments**                         | Identifiers, internal messages, comments, JSDoc — everything in English. Documentation (`docs/`) was originally in PT-BR (now translated).                            |
| **Zero `dependencies`**                                  | `package.json` ships `"dependencies": {}`. Everything via peer dep. Reduces the supply chain.                                                                         |
| **`MODULE_ACTION_RESULT` log key pattern**               | Even in tests — makes migrating bymax-fitness code easier.                                                                                                            |
| **Dependency inversion**                                 | Destinations via `ILogDestination`. OTel via optional detection. Consumer picks transports.                                                                           |
| **A silent failure in the logger never crashes the app** | Errors in destinations are logged (meta-log) but not propagated.                                                                                                      |
| **Async by default**                                     | Pino async via worker threads — never block the event loop.                                                                                                           |
| **Multi-tenant ready**                                   | `tenantId` propagation via `AsyncLocalStorage`; in the additional application code.                                                                                   |
| **Declarative PII redaction**                            | Configured `pino.redact` paths; safe defaults merge with consumer extensions.                                                                                         |
| **Conventional Commits**                                 | `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Drives the semver bump at release.                                                                          |

### 1.3 Phase summary

| Phase | Content                                                                                                                                                                                                                   | Tasks  | Complexity |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| **1** | Foundation + Pino integration (scaffold, Husky/commitlint tooling, types, contracts, base `PinoLoggerService`, sync module, default stdout destination)                                                                   | 20     | MEDIUM     |
| **2** | Context propagation (`AsyncLocalStorage`) + OpenTelemetry mixin (optional detection + `traceId`/`spanId` injection)                                                                                                       | 14     | MEDIUM     |
| **3** | HTTP Interceptor + Exception Filter + RequestIdMiddleware + Decorators (`@InjectLogger`, `@LogContext`, `@LogPerformance`)                                                                                                | 14     | MEDIUM     |
| **4** | `PrettyDevDestination` + `DestinationRegistry` lifecycle + truncation + `forRootAsync` + `@InjectLogger` context wiring + `useNestLogger` helper + `sanitize-error.util` + perf benchmark + E2E suite + mutation baseline | 14     | HIGH       |
| **5** | README + CHANGELOG + SECURITY.md + CLAUDE.md + AGENTS.md + CI workflows + bundle budgets + consumer dev-link smoke (GA gate) + tag + `pnpm publish --provenance`                                                          | 11     | LOW        |
|       | **Total**                                                                                                                                                                                                                 | **73** | —          |

> **No time estimate** — this plan is for AI agent execution. Duration in human days does not apply. Relative complexity per phase is documented above and broken down per sub-step in the [Complexity Matrix in Appendix B](#appendix-b--complexity-matrix). Use these signals to prioritize more careful human review on HIGH-complexity phases.

### 1.4 Global Done criteria per phase

A phase is only marked **Done** when, **cumulatively**:

- [ ] `pnpm typecheck` passes without errors
- [ ] `pnpm lint` passes without warnings (no `eslint-disable`)
- [ ] `pnpm test:cov` passes with **100% coverage** on the phase's files (per-file gate via `jest.config.ts`; end aggregated gate via `jest.coverage.config.ts` run in pre-publish)
- [ ] `pnpm build` produces `dist/` with `.mjs`, `.cjs`, `.d.ts` for every declared subpath
- [ ] All sub-step acceptance criteria checked
- [ ] JSDoc present on every new export
- [ ] `git status` clean (commits made with Conventional Commits)
- [ ] `/bymax-quality:code-review` executed and findings applied — **no CRITICAL or HIGH findings unresolved before merge** (Phase 1 quantitative threshold, applies to every phase)
- [ ] **Every PR in the phase appends an `[Unreleased]` entry to `CHANGELOG.md`** describing the user-visible change (Added / Changed / Fixed / Deprecated / Removed) — the entry is the audit trail for the semver bump declared in Appendix F. Empty changes (refactors with no public-surface impact) explicitly note `chore: no public-surface change` in the CHANGELOG to make the omission intentional.

### 1.5 Expected end file structure (after Phase 5)

Root directory of the `nest-logger/` repo mirrors the EXTRACTION_ROADMAP §4 template:

```
nest-logger/
├── .github/workflows/      # ci.yml, codeql.yml, release.yml, scorecard.yml
├── docs/
│   ├── technical_specification.md
│   ├── development_plan.md          ← this file
│   ├── development_tasks.md         ← generated next
│   ├── mutation_testing_plan.md
│   ├── mutation_testing_results.md
│   └── guidelines/                  ← domain-specific (parity with nest-auth/docs/guidelines/)
│       ├── PINO-REDACTION-GUIDELINES.md
│       ├── OTEL-INTEGRATION-GUIDELINES.md
│       └── DESTINATIONS-IMPLEMENTATION-GUIDELINES.md
├── scripts/check-size.mjs
├── src/server/              # main entry — see spec §3.1
├── src/shared/              # zero deps — types & constants
├── test/e2e/                # isolated e2e specs
├── package.json
├── tsup.config.ts
├── tsconfig.json (+ build / server / e2e / jest variants)
├── jest.config.ts (+ coverage / e2e / stryker variants)
├── stryker.config.json
├── eslint.config.mjs
├── README.md / CHANGELOG.md / SECURITY.md / LICENSE / CLAUDE.md / AGENTS.md
```

### 1.6 How this plan feeds `development_tasks.md`

Every numbered **sub-step** in this plan (§2.X, §3.X, etc.) becomes **one or more executable tasks** in `development_tasks.md`. Derivation rule:

- Sub-step with **a single file + logic < 100 LoC** → **1 task**
- Sub-step with **multiple related files** → **grouped task** with a per-file checklist
- Sub-step with **logic > 200 LoC** → **task split** into red (test), green (impl), refactor

The task carries the complete prompt for AI agent execution (Role / Project / Preconditions / Required Reading / Task / Deliverables / Constraints / Verification / Completion Protocol — `/bymax-workflow:phase-tasks` pattern).

---

## 2. Phase 1 — Foundation + Pino Integration

> **Phase goal:** Establish the complete project scaffold, define public contracts (interfaces, types, constants), implement the base `PinoLoggerService` with the default destination (stdout JSON), and register a sync `BymaxLoggerModule.forRoot()`. At the end of the phase, you can install the lib in a NestJS fixture app and see structured JSON logs.
>
> **Complexity:** MEDIUM.
>
> **Critical paths (mutation 100% required):** `src/server/services/pino-logger.service.ts`, `src/server/config/validate-options.ts`, `src/server/utils/compile-redact-paths.util.ts`. Coverage for **every** file in the phase: **100%** (gate `jest.config.ts` + aggregate `jest.coverage.config.ts`).

### 2.1 Project scaffold

**Goal:** Create the folder structure, configuration files, and base dependencies, mirroring the `EXTRACTION_ROADMAP.md` §3 template and the canonical configs from `nest-auth`.

**Files to create:**

```
nest-logger/
├── .gitignore
├── .prettierrc
├── .npmignore
├── eslint.config.mjs
├── jest.config.ts
├── jest.coverage.config.ts
├── jest.e2e.config.ts
├── jest.stryker.config.ts
├── stryker.config.json
├── tsconfig.json
├── tsconfig.build.json
├── tsconfig.server.json
├── tsconfig.e2e.json
├── tsconfig.jest.json
├── tsup.config.ts
├── package.json
├── scripts/check-size.mjs
├── src/server/index.ts          # empty in this step — structure only
├── src/shared/index.ts          # empty in this step
└── test/e2e/.gitkeep
```

**Reference content:**

Copy from `/Users/maximiliano/Documents/MyApps/nest-auth/` and adapt (replace `nest-auth` with `nest-logger`):

| Source (nest-auth)        | Destination (nest-logger) | Adaptation                                                                                                                        |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.json`           | `tsconfig.json`           | Swap path aliases: 2 subpaths instead of 5 (`@bymax-one/nest-logger`, `@bymax-one/nest-logger/shared`)                            |
| `tsconfig.build.json`     | `tsconfig.build.json`     | Identical (extends tsconfig.json, excludes `**/*.spec.ts`, `test/`)                                                               |
| `tsconfig.server.json`    | `tsconfig.server.json`    | `include: ['src/server/**/*']`                                                                                                    |
| `tsconfig.e2e.json`       | `tsconfig.e2e.json`       | Includes `test/e2e/`; more permissive (no strict null checks in e2e helpers)                                                      |
| `tsconfig.jest.json`      | `tsconfig.jest.json`      | Identical                                                                                                                         |
| `jest.config.ts`          | `jest.config.ts`          | Swap `moduleNameMapper` for 2 subpaths; coverage threshold **100% global** (statements/branches/functions/lines) — per-file gate. |
| `jest.coverage.config.ts` | `jest.coverage.config.ts` | **100% global** threshold (aggregate unit+E2E release gate) — see §6.5                                                            |
| `jest.e2e.config.ts`      | `jest.e2e.config.ts`      | Identical (rootDir `test/e2e`)                                                                                                    |
| `jest.stryker.config.ts`  | `jest.stryker.config.ts`  | Identical                                                                                                                         |
| `stryker.config.json`     | `stryker.config.json`     | Swap `tsconfig.json`, `tempDirName` stays; thresholds: high 99, low 95, break 95                                                  |
| `tsup.config.ts`          | `tsup.config.ts`          | **Rewrite** — 2 entries (`server`, `shared`); externals: peer deps from package.json (see §2.1.3 below)                           |
| `eslint.config.mjs`       | `eslint.config.mjs`       | Copy; remove rules specific to `oauth/`, `crypto/`; keep `eslint-plugin-security`, `eslint-plugin-import`                         |
| `.prettierrc`             | `.prettierrc`             | Identical                                                                                                                         |
| `.gitignore`              | `.gitignore`              | Identical                                                                                                                         |
| `scripts/check-size.mjs`  | `scripts/check-size.mjs`  | **Rewrite** — 2 entries: `server` budget 12_000 brotli, `shared` budget 3_500 brotli (see §6.4)                                   |

**Detail — `package.json` for this phase:**

```json
{
  "name": "@bymax-one/nest-logger",
  "version": "0.1.0-alpha.0",
  "description": "Structured JSON logging for NestJS based on Pino 10, with optional OpenTelemetry correlation.",

  "author": "Bymax One <support@bymax.one>",
  "license": "MIT",
  "homepage": "https://github.com/bymaxone/nest-logger#readme",
  "repository": { "type": "git", "url": "https://github.com/bymaxone/nest-logger.git" },
  "bugs": { "url": "https://github.com/bymaxone/nest-logger/issues" },
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "LICENSE", "README.md", "CHANGELOG.md"],
  "exports": {
    ".": {
      "types": "./dist/server/index.d.ts",
      "import": "./dist/server/index.mjs",
      "require": "./dist/server/index.cjs"
    },
    "./shared": {
      "types": "./dist/shared/index.d.ts",
      "import": "./dist/shared/index.mjs",
      "require": "./dist/shared/index.cjs"
    }
  },
  "scripts": {
    "build": "pnpm clean && tsup",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "test": "jest",
    "test:cov": "jest --coverage",
    "test:watch": "jest --watch",
    "test:e2e": "jest --config jest.e2e.config.ts",
    "test:all": "pnpm test && pnpm test:e2e",
    "test:cov:all": "jest --config jest.coverage.config.ts --coverage",
    "mutation": "stryker run",
    "mutation:incremental": "stryker run --incremental",
    "mutation:dry-run": "stryker run --dryRunOnly",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.server.json",
    "size": "node scripts/check-size.mjs",
    "clean": "rm -rf dist coverage",
    "prepublishOnly": "pnpm clean && pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build",
    "release": "pnpm publish --provenance"
  },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "pino": "^10.0.0",
    "reflect-metadata": "^0.2.0",
    "pino-pretty": "^13.0.0",
    "@opentelemetry/api": "^1.9.0"
  },
  "peerDependenciesMeta": {
    "pino-pretty": { "optional": true },
    "@opentelemetry/api": { "optional": true }
  },
  "devDependencies": {
    "@nestjs/common": "^11.1.20",
    "@nestjs/core": "^11.1.20",
    "@nestjs/platform-express": "^11.1.20",
    "@nestjs/testing": "^11.1.20",
    "@opentelemetry/api": "^1.9.0",
    "@stryker-mutator/core": "^9",
    "@stryker-mutator/jest-runner": "^9",
    "@stryker-mutator/typescript-checker": "^9",
    "@types/express": "^5.0.6",
    "@types/jest": "^30.0.0",
    "@types/node": "^24",
    "@types/supertest": "^7.2.0",
    "@typescript-eslint/eslint-plugin": "^8.59.3",
    "@typescript-eslint/parser": "^8.59.3",
    "eslint": "^9.39.4",
    "eslint-config-prettier": "^10.1.8",
    "eslint-import-resolver-typescript": "^4.4.4",
    "eslint-plugin-import": "^2.32.0",
    "eslint-plugin-prettier": "^5.5.5",
    "eslint-plugin-security": "^4.0.0",
    "jest": "^30.4.2",
    "pino": "^10.x",
    "pino-pretty": "^13.x",
    "prettier": "^3.8.3",
    "reflect-metadata": "^0.2.2",
    "supertest": "^7.2.2",
    "ts-jest": "^29.4.9",
    "ts-node": "^10.9.2",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3"
  },
  "packageManager": "pnpm@11.20.0",
  "engines": { "node": ">=24.0.0" },
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
}
```

**Detail — `tsup.config.ts`:**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig([
  // Server entry (main) — Node.js + NestJS
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    tsconfig: 'tsconfig.build.json',
    outDir: 'dist',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
    external: [/^@nestjs\//, 'reflect-metadata', 'pino', 'pino-pretty', '@opentelemetry/api'],
    target: 'node24',
    clean: false,
    splitting: false,
    treeshake: true,
    sourcemap: false
  },
  // Shared entry — types + constants (zero deps)
  {
    entry: { 'shared/index': 'src/shared/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    tsconfig: 'tsconfig.build.json',
    outDir: 'dist',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
    target: 'node24',
    clean: false,
    splitting: false,
    treeshake: true,
    sourcemap: false
  }
])
```

**Acceptance criteria:**

- [ ] Directory structure created per the tree above
- [ ] `package.json` with all scripts, peer deps, and devDeps listed
- [ ] `tsconfig.json` inheriting strict settings from nest-auth (target ES2022, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [ ] `tsup.config.ts` configured with 2 entries
- [ ] `eslint.config.mjs` in flat config v9 functional (zero warnings on empty folder)
- [ ] `pnpm install` completes without errors
- [ ] `pnpm typecheck` passes on empty `src/server/index.ts` and `src/shared/index.ts` (placeholder comment only)
- [ ] `pnpm lint` passes without warnings
- [ ] `pnpm build` produces `dist/server/index.{mjs,cjs,d.ts}` and `dist/shared/index.{mjs,cjs,d.ts}` even with empty source

**Validation commands:**

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
ls -la dist/server/  # confirms .mjs, .cjs, .d.ts
ls -la dist/shared/
```

**Dependencies:** In the prior sub-step. This is the phase entry point.

**Risks/Notes:**

- ⚠️ `pnpm@11.20.0` is required; using a different version may break lockfile resolution
- ⚠️ Node 24 LTS is the minimum; `createRequire` and `import.meta.url` are essential for OTel detection
- ⚠️ Do not copy `tsup.config.ts` from nest-auth literally — nest-auth has 5 entries, nest-logger only 2

### 2.1a Husky + commitlint + lint-staged tooling

**Goal:** Wire the local Git hooks that make the Conventional Commits workflow declared in §1.2 actually enforced — and enable the semver-bump-from-commits flow §1.2 promises (later consumed by `changesets` or `semantic-release` in Phase 5 via §6.7a/E9).

**Files to create:**

```
.husky/
├── pre-commit          # runs `pnpm lint-staged`
└── commit-msg          # runs `pnpm commitlint --edit "$1"`
commitlint.config.cjs   # Conventional Commits config (@commitlint/config-conventional)
```

**Files to modify:**

```
package.json   # add devDeps + scripts + lint-staged block + "prepare": "husky"
```

**Skeleton — `.husky/pre-commit`:**

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"
pnpm lint-staged
```

**Skeleton — `.husky/commit-msg`:**

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"
pnpm commitlint --edit "$1"
```

**Skeleton — `commitlint.config.cjs`:**

```javascript
/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // tighten subject-case to lowercase + ban WIP/TODO commits on main
    'subject-case': [2, 'always', ['sentence-case', 'lower-case']],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
    ]
  }
}
```

**Skeleton — `package.json` additions:**

```json
{
  "scripts": {
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{md,json,yml,yaml}": ["prettier --write"]
  },
  "devDependencies": {
    "@commitlint/cli": "^19.6.0",
    "@commitlint/config-conventional": "^19.6.0",
    "husky": "^9.1.7",
    "lint-staged": "^15.2.10"
  }
}
```

**Acceptance criteria:**

- [ ] `pnpm install` triggers `prepare` → installs Husky hooks
- [ ] Test commit with invalid type (`git commit -m "bad: message"`) is REJECTED by the `commit-msg` hook
- [ ] Test commit with valid Conventional Commit (`git commit -m "feat(logger): add scaffold"`) is ACCEPTED
- [ ] Stage a `.ts` file with formatting issues → `git commit` runs `eslint --fix` + `prettier --write` ONLY on staged files (verify untracked/unstaged files are untouched)
- [ ] Hooks are version-controlled (committed to the repo under `.husky/`)
- [ ] **This enables the semver-bump-from-commits flow declared in §1.2** — referenced by §6.7a (changesets/semantic-release wiring)

**Validation commands:**

```bash
pnpm install
git commit --allow-empty -m "bad: invalid type"   # expect rejection
git commit --allow-empty -m "chore: tooling test" # expect success
```

**Dependencies:** §2.1 (`package.json` exists).

**Risks/Notes:**

- ⚠️ Husky 9 changed the init flow — use `pnpm exec husky init` once, then version-control the generated `.husky/` directory.
- ⚠️ `lint-staged` MUST scope to staged files only — never globalize `eslint .` in the hook, it slows commits to a crawl and may modify unrelated files.

### 2.2 Shared types and constants (`src/shared/`)

**Goal:** Define public types and constants with in the NestJS dependencies. These modules can be imported in the frontend (e.g., log key validation in an admin form) without bringing overhead.

**Files to create:**

```
src/shared/
├── types/
│   ├── log-level.type.ts
│   ├── log-entry.type.ts
│   └── service-metadata.type.ts
├── constants/
│   ├── reserved-log-keys.constants.ts
│   └── log-keys-convention.constants.ts
└── index.ts
```

**Skeleton — `src/shared/types/log-level.type.ts`:**

```typescript
/**
 * Pino log levels (mirrored to NestJS-compatible names).
 *
 * Numeric mapping is documented in the spec §C — Log Level Mapping.
 *
 * @example
 *   const level: LogLevel = 'info'
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
```

**Skeleton — `src/shared/types/log-entry.type.ts`:**

```typescript
import type { LogLevel } from './log-level.type'

/**
 * Shape of a single log entry as serialized to JSON output.
 * Used by destinations and downstream parsers.
 */
export interface LogEntry {
  /** Pino numeric level (30 = info, 50 = error, etc.). */
  level: number
  /** ISO 8601 UTC timestamp string OR epoch milliseconds (numeric). */
  time: string | number
  /** Human-readable message. */
  msg: string
  /** Convention key — MODULE_ACTION_RESULT format. */
  logKey?: string
  /** Service metadata. */
  service?: ServiceMetadata
  /** Optional NestJS context (class name). */
  context?: string
  /** Optional correlation IDs propagated via AsyncLocalStorage. */
  requestId?: string
  tenantId?: string
  userId?: string
  /** Optional trace context injected when OpenTelemetry SDK is active. */
  traceId?: string
  spanId?: string
  /** Arbitrary additional fields. */
  [key: string]: unknown
}

import type { ServiceMetadata } from './service-metadata.type'
```

**Skeleton — `src/shared/types/service-metadata.type.ts`:**

```typescript
/**
 * Service metadata propagated to every log entry.
 * Aligned with OpenTelemetry semantic conventions:
 *   - https://opentelemetry.io/docs/specs/semconv/resource/#service
 */
export interface ServiceMetadata {
  /** OTel attribute `service.name`. */
  name: string
  /** OTel attribute `service.version`. Typically commit SHA or semver. */
  version: string
}
```

**Skeleton — `src/shared/constants/log-keys-convention.constants.ts`:**

```typescript
/**
 * Regex enforcing the MODULE_ACTION_RESULT convention.
 *
 * Pattern:
 *   - At least 2 segments separated by `_`
 *   - Each segment starts with an uppercase letter
 *   - Each segment may contain uppercase letters, digits, underscores
 *
 * @example
 *   LOG_KEYS_CONVENTION_REGEX.test('USER_CREATED')         // true (2 segments)
 *   LOG_KEYS_CONVENTION_REGEX.test('AUTH_LOGIN_FAILED')    // true (3 segments)
 *   LOG_KEYS_CONVENTION_REGEX.test('login_success')        // false (lowercase)
 *   LOG_KEYS_CONVENTION_REGEX.test('LOGIN')                // false (single segment)
 */
export const LOG_KEYS_CONVENTION_REGEX = /^[A-Z][A-Z0-9_]+_[A-Z][A-Z0-9_]+(_[A-Z][A-Z0-9_]+)?$/
```

**Skeleton — `src/shared/constants/reserved-log-keys.constants.ts`:**

```typescript
/**
 * Log keys reserved by the library itself. Count: **16**.
 *
 * Consumer apps SHOULD NOT use these names for application-level events
 * to avoid collision in log aggregation queries.
 *
 * @see spec §12.3 for the authoritative list.
 */
export const RESERVED_LOG_KEYS = {
  LOGGER_BOOTSTRAP_OK: 'LOGGER_BOOTSTRAP_OK',
  LOGGER_BOOTSTRAP_WARNING: 'LOGGER_BOOTSTRAP_WARNING',
  LOGGER_SHUTDOWN_OK: 'LOGGER_SHUTDOWN_OK',
  HTTP_REQUEST_START: 'HTTP_REQUEST_START',
  HTTP_REQUEST_SUCCESS: 'HTTP_REQUEST_SUCCESS',
  HTTP_REQUEST_REDIRECT: 'HTTP_REQUEST_REDIRECT',
  HTTP_REQUEST_CLIENT_ERROR: 'HTTP_REQUEST_CLIENT_ERROR',
  HTTP_REQUEST_SERVER_ERROR: 'HTTP_REQUEST_SERVER_ERROR',
  HTTP_REQUEST_COMPLETED: 'HTTP_REQUEST_COMPLETED',
  HTTP_EXCEPTION_HANDLED: 'HTTP_EXCEPTION_HANDLED',
  HTTP_EXCEPTION_UNHANDLED: 'HTTP_EXCEPTION_UNHANDLED',
  METHOD_EXECUTION: 'METHOD_EXECUTION',
  METHOD_SLOW_EXECUTION: 'METHOD_SLOW_EXECUTION',
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED'
} as const

export type ReservedLogKey = (typeof RESERVED_LOG_KEYS)[keyof typeof RESERVED_LOG_KEYS]
```

**Skeleton — `src/shared/index.ts`:**

```typescript
// Types
export type { LogLevel } from './types/log-level.type'
export type { LogEntry } from './types/log-entry.type'
export type { ServiceMetadata } from './types/service-metadata.type'

// Constants
export { LOG_KEYS_CONVENTION_REGEX } from './constants/log-keys-convention.constants'
export { RESERVED_LOG_KEYS } from './constants/reserved-log-keys.constants'
export type { ReservedLogKey } from './constants/reserved-log-keys.constants'
```

**Acceptance criteria:**

- [ ] All files created per the tree
- [ ] JSDoc present on every export (verifiable via `tsc --emitDeclarationOnly` which includes comments)
- [ ] `pnpm build` generates `dist/shared/index.d.ts` listing all exports
- [ ] `pnpm typecheck` passes
- [ ] Bundle `dist/shared/index.mjs` < 3.5 KB brotli (validate with `pnpm size` in §2.9)
- [ ] Subpath `import('@bymax-one/nest-logger/shared')` resolves correctly in a consumer fixture

**Validation commands:**

```bash
pnpm build
node -e "import('./dist/shared/index.mjs').then(m => console.log(Object.keys(m)))"
# Expected: [ 'LOG_KEYS_CONVENTION_REGEX', 'RESERVED_LOG_KEYS' ]
```

**Dependencies:** §2.1 complete.

**Risks/Notes:**

- ⚠️ `import type` is mandatory for types — avoids inclusion in the JS bundle
- ⚠️ Constants must be `as const` to preserve literal types in `dist/.d.ts`
- ⚠️ Do not add logic to `shared/` — only pure types and constants

### 2.3 Interfaces and contracts (`src/server/interfaces/`)

**Goal:** Define every public interface the consumer can implement or reference — `ILogDestination`, `LogContext`, `BymaxLoggerModuleOptions`.

**Files to create:**

```
src/server/interfaces/
├── log-destination.interface.ts
├── log-context.interface.ts
├── logger-module-options.interface.ts
└── index.ts
```

**Skeleton — `src/server/interfaces/log-destination.interface.ts`:**

```typescript
import type { LogLevel } from '../../shared/types/log-level.type'

/**
 * Pluggable destination for log entries.
 *
 * Implementations receive the end JSON-serialized payload (with trailing newline)
 * and write it wherever they want — file, network, database, queue, etc.
 *
 * Implementations MUST be non-blocking and tolerant to errors. A destination that
 * throws or hangs MUST NOT break the application — the library's
 * `DestinationRegistry` catches errors and emits a meta-log
 * (`LOGGER_DESTINATION_WRITE_FAILED`).
 *
 * @example
 *   class FileDestination implements ILogDestination {
 *     readonly name = 'file'
 *     write(payload: string): void {
 *       fs.appendFileSync('/var/log/app.log', payload)
 *     }
 *   }
 */
export interface ILogDestination {
  /** Unique identifier — used in error logs and registry lookups. */
  readonly name: string

  /**
   * Minimum log level this destination accepts. Entries below this level
   * are not written. Undefined means "accept everything".
   */
  readonly minLevel?: LogLevel

  /**
   * Write a single log entry. Payload is the already-serialized JSON string
   * (UTF-8, terminated with `\n`).
   *
   * Implementations may:
   *   - Write synchronously (e.g., process.stdout)
   *   - Buffer and flush periodically (e.g., HTTP batching)
   *   - Return a Promise for async I/O
   *
   * Errors thrown here are caught by the library; the destination may be
   * temporarily skipped if it consistently fails.
   */
  write(payload: string): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called once during NestJS module init.
   * Use for opening connections, allocating buffers, scheduling flushers.
   */
  onInit?(): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called during NestJS `onApplicationShutdown`.
   * MUST flush any pending writes and close resources.
   *
   * The library awaits this — graceful shutdown blocks until all destinations
   * return.
   */
  onShutdown?(): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called once after EVERY destination's `onInit`
   * settled, and awaited. Only useful to a destination that buffers.
   */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | PromiseLike<void>
}
```

**Skeleton — `src/server/interfaces/log-context.interface.ts`:**

```typescript
/**
 * Per-request context propagated via AsyncLocalStorage.
 * Mergeable shape — consumer code may extend with arbitrary keys via
 * `LogContextService.set(key, value)`.
 */
export interface LogContext {
  /** Correlation ID — typically from `x-request-id` header or generated. */
  requestId?: string
  /** Multi-tenant identifier — read from `x-tenant-id` header or auth claim. */
  tenantId?: string
  /** Authenticated user ID. */
  userId?: string
  /** OpenTelemetry trace ID (32 hex chars). Injected by `TraceContextMixin`. */
  traceId?: string
  /** OpenTelemetry span ID (16 hex chars). */
  spanId?: string
  /** Free-form extensions. */
  [key: string]: unknown
}
```

**Skeleton — `src/server/interfaces/logger-module-options.interface.ts`:**

```typescript
import type { ModuleMetadata, Type } from '@nestjs/common'
import type { LogLevel } from '../../shared/types/log-level.type'
import type { ServiceMetadata } from '../../shared/types/service-metadata.type'
import type { ILogDestination } from './log-destination.interface'

/**
 * Synchronous configuration for `BymaxLoggerModule.forRoot()`.
 *
 * See `docs/technical_specification.md` §4.1 for full semantics of every field.
 */
export interface BymaxLoggerModuleOptions {
  /** Mandatory service metadata. */
  service: ServiceMetadata

  /** Minimum level emitted. Default: 'info' (prod) / 'debug' (other). */
  level?: LogLevel

  /** Register module as `@Global()`. Default: true. */
  isGlobal?: boolean

  /** Replace NestJS internal logger via `app.useLogger()`. Default: true. */
  shouldUseAsNestLogger?: boolean

  /** Additional Pino redact paths — merged with `DEFAULT_REDACT_PATHS`. */
  redactPaths?: readonly string[]

  /** Censor string written in place of redacted values. Default: '[REDACTED]'. */
  redactCensor?: string

  /** Disable default redact paths (use with caution). Default: false. */
  shouldDisableDefaultRedact?: boolean

  /** Custom destinations beyond `DefaultStdoutDestination`. */
  destinations?: readonly ILogDestination[]

  /** Force pretty-print output. Default: NODE_ENV !== 'production'. */
  isPretty?: boolean

  /** HTTP module configuration. */
  http?: HttpOptions

  /** OpenTelemetry integration tuning. */
  otel?: OtelOptions

  /** Maximum size in bytes per log entry. Default: 65536. */
  maxEntrySizeBytes?: number

  /** Custom Pino serializers, merged with defaults. */
  serializers?: Record<string, (input: unknown) => unknown>

  /** Custom timestamp function. Default: () => new Date().toISOString(). */
  timestamp?: () => string
}

export interface HttpOptions {
  isEnabled?: boolean
  shouldCaptureExceptions?: boolean
  shouldGenerateRequestId?: boolean
  excludePaths?: readonly RegExp[]
  tenantIdHeader?: string
}

export interface OtelOptions {
  shouldAutoInjectTraceContext?: boolean
  /**
   * Shortcut that derives sensible defaults for `traceIdField`/`spanIdField`/
   * `traceFlagsField` based on a target casing.
   *
   * - `'camelCase'` (default) → `traceId` / `spanId` / `traceFlags`
   * - `'snake_case'`          → `trace_id` / `span_id` / `trace_flags` (OTel Logs Data Model wire format)
   *
   * Individual `*Field` overrides ALWAYS win over the shortcut.
   */
  fieldFormat?: 'camelCase' | 'snake_case'
  traceIdField?: string
  spanIdField?: string
  traceFlagsField?: string
}

/**
 * Async configuration for `BymaxLoggerModule.forRootAsync()`.
 * Standard NestJS dynamic module async options shape.
 */
export interface BymaxLoggerModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: unknown[]) => BymaxLoggerModuleOptions | Promise<BymaxLoggerModuleOptions>
  inject?: readonly (string | symbol | Type<unknown>)[]
  useExisting?: Type<BymaxLoggerModuleOptionsFactory>
  useClass?: Type<BymaxLoggerModuleOptionsFactory>
}

export interface BymaxLoggerModuleOptionsFactory {
  createLoggerOptions(): BymaxLoggerModuleOptions | Promise<BymaxLoggerModuleOptions>
}
```

**Skeleton — `src/server/interfaces/index.ts`:**

```typescript
export type { ILogDestination } from './log-destination.interface'
export type { LogContext } from './log-context.interface'
export type {
  BymaxLoggerModuleOptions,
  BymaxLoggerModuleAsyncOptions,
  BymaxLoggerModuleOptionsFactory,
  HttpOptions,
  OtelOptions
} from './logger-module-options.interface'
```

**Acceptance criteria:**

- [ ] All interfaces created with full JSDoc
- [ ] `readonly` on immutable properties (consistent with `exactOptionalPropertyTypes`)
- [ ] `BymaxLoggerModuleAsyncOptions` follows the official NestJS async dynamic module pattern
- [ ] `pnpm typecheck` passes
- [ ] In the `any` anywhere in signatures

**Validation commands:**

```bash
pnpm typecheck
# Verify via grep that in the 'any' was introduced:
grep -n ': any\b\|any\[\]' src/server/interfaces/  # expected: in the match
```

**Dependencies:** §2.2 (needs `LogLevel`, `ServiceMetadata` in shared).

**Risks/Notes:**

- ⚠️ Do not yet export these interfaces directly from the server `index.ts` — wait until Phase 1 completes
- ⚠️ Keep `BymaxLoggerModuleOptions` separate from `BymaxLoggerModuleAsyncOptions` (do not merge into a union)

### 2.4 Constants and DI tokens

**Goal:** Define injection tokens (`Symbol()`) and internal constants (default redact paths, log levels mapping).

**Files to create:**

```
src/server/constants/
├── injection-tokens.constants.ts
├── default-redact-paths.constants.ts
└── log-levels.constants.ts
```

**Skeleton — `src/server/constants/injection-tokens.constants.ts`:**

```typescript
/**
 * Dependency injection tokens.
 *
 * Symbols are used instead of strings to avoid collision with tokens from other
 * libraries (string tokens may match by accident; symbols are guaranteed unique).
 * This pattern is inherited from `@bymax-one/nest-auth`.
 *
 * `LOGGER_OPTIONS_TOKEN` is OWNED by this file (manual `Symbol.for`) — NOT
 * re-exported from `logger.module.builder.ts`. This breaks the ordering
 * coupling between §2.4 (constants) and §2.8 (module builder): constants are
 * created first, and the builder imports the token from here.
 *
 * Rationale: option 2 of the E11 fix — clearer ownership, no circular import
 * risk, builder file becomes a pure consumer of the token symbol.
 */
export const LOGGER_OPTIONS_TOKEN = Symbol.for('@bymax-one/nest-logger:options')
export const LOGGER_PINO_INSTANCE_TOKEN = Symbol('BYMAX_LOGGER_PINO_INSTANCE')
export const LOGGER_DESTINATIONS_TOKEN = Symbol('BYMAX_LOGGER_DESTINATIONS')
export const LOG_CONTEXT_TOKEN = Symbol('BYMAX_LOGGER_LOG_CONTEXT')
```

**Skeleton — `src/server/constants/default-redact-paths.constants.ts`:**

```typescript
/**
 * Default Pino `redact.paths` applied automatically by the library.
 *
 * These paths cover commonly-leaked PII and credentials. Consumers can:
 *   - Add more via `redactPaths` option (merged)
 *   - Disable all via `shouldDisableDefaultRedact: true` (NOT recommended)
 *
 * Path syntax follows `fast-redact` conventions (engine behind `pino.redact`):
 *   - Wildcard `*` matches **one level only** (NOT recursive).
 *   - `'*.password'`        → matches `body.password`, `meta.password`, …
 *   - `'*.*.password'`      → matches `body.user.password`, …
 *   - `'a.b.c'`             → exact dot path
 *   - `'req.headers["x-api-key"]'` → bracket syntax for headers with hyphens
 *
 * For defense-in-depth coverage of nested payloads, depths 1-4 are listed
 * explicitly for every sensitive field.
 *
 * @see https://github.com/davidmarkclements/fast-redact#wildcards
 * @see https://github.com/pinojs/pino/blob/main/docs/redaction.md
 */

/**
 * Generate wildcard variants from depth 1 to 4 for a given leaf field name.
 *
 * @example
 *   depth('password')
 *   → ['*.password', '*.*.password', '*.*.*.password', '*.*.*.*.password']
 */
const depth = (field: string): readonly string[] =>
  ['*', '*.*', '*.*.*', '*.*.*.*'].map((prefix) => `${prefix}.${field}`)

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  // Passwords — depth 1-4
  ...depth('password'),
  ...depth('passwordHash'),
  ...depth('passwordConfirm'),
  ...depth('newPassword'),
  ...depth('oldPassword'),
  // Tokens
  ...depth('token'),
  ...depth('accessToken'),
  ...depth('refreshToken'),
  ...depth('idToken'),
  ...depth('apiKey'),
  ...depth('apiSecret'),
  // MFA
  ...depth('mfaSecret'),
  ...depth('mfaRecoveryCodes'),
  ...depth('totpSecret'),
  // Payment (PCI DSS)
  ...depth('cardNumber'),
  ...depth('cardCvv'),
  ...depth('cvv'),
  ...depth('cvc'),
  ...depth('cardExpiry'),
  // Personal documents (BR — LGPD)
  ...depth('cpf'),
  ...depth('cnpj'),
  ...depth('rg'),
  // HTTP headers commonly carrying secrets (absolute paths)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  // Conservative PII — email can be disabled if the app justifies logging
  ...depth('email')
] as const
```

**Why `depth()` instead of static paths?** Avoids ~110 duplicated lines of fixed paths and centralizes the rule "we cover 4 nesting levels". Changing the global limit (e.g., to 5) is a one-line edit. **Note**: the `depth` function is pure (no side effects) — unit tests must validate that `depth('foo')` returns exactly `['*.foo', '*.*.foo', '*.*.*.foo', '*.*.*.*.foo']`.

**Skeleton — `src/server/constants/log-levels.constants.ts`:**

```typescript
import type { LogLevel } from '../../shared/types/log-level.type'

/**
 * Pino numeric level mapping.
 * @see https://github.com/pinojs/pino/blob/main/docs/api.md#level-string
 */
export const PINO_LEVEL_NUMBERS: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10
} as const

/**
 * Reverse lookup — numeric Pino level → string.
 */
export const PINO_LEVEL_NAMES: Record<number, LogLevel> = Object.fromEntries(
  Object.entries(PINO_LEVEL_NUMBERS).map(([name, num]) => [num, name as LogLevel])
) as Record<number, LogLevel>

/**
 * Mapping NestJS LogLevel → Pino LogLevel.
 * NestJS uses `'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal'`.
 */
export const NEST_TO_PINO_LEVEL: Record<string, LogLevel> = {
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'trace',
  fatal: 'fatal'
} as const
```

**Acceptance criteria:**

- [ ] Unique Symbols (verifiable: `LOGGER_OPTIONS_TOKEN === LOGGER_OPTIONS_TOKEN` is `true`; `LOGGER_OPTIONS_TOKEN !== LOGGER_DESTINATIONS_TOKEN` is `true`)
- [ ] `DEFAULT_REDACT_PATHS` is `readonly` (consumer cannot mutate)
- [ ] Lookup `PINO_LEVEL_NAMES[30]` returns `'info'`
- [ ] Lookup `NEST_TO_PINO_LEVEL['log']` returns `'info'`
- [ ] `pnpm typecheck` passes

**Validation commands:**

```bash
pnpm typecheck
node -e "import('./dist/server/index.mjs').then(m => console.log(typeof m.LOGGER_OPTIONS_TOKEN))"
# Expected: symbol
```

**Dependencies:** §2.2 (LogLevel type).

### 2.5 Options validation and defaults

**Goal:** Implement `validate-options.ts` (zod-free, manual validation with clear messages) and `default-options.ts` (merge of defaults with consumer options).

**Files to create:**

```
src/server/config/
├── default-options.ts
└── validate-options.ts
src/server/utils/
└── compile-redact-paths.util.ts
```

**Skeleton — `src/server/config/validate-options.ts`:**

```typescript
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import type { LogLevel } from '../../shared/types/log-level.type'

const VALID_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']

/**
 * Validates options at module bootstrap. Throws with actionable error messages.
 *
 * @throws Error if `service.name` or `service.version` is missing/empty
 * @throws Error if `level` is provided but not a valid LogLevel
 * @throws Error if `maxEntrySizeBytes` is non-positive
 *
 * Best-effort validation; runtime issues from custom serializers/destinations
 * are caught lazily and emitted as meta-logs.
 */
export function validateOptions(options: BymaxLoggerModuleOptions): void {
  if (!options.service) {
    throw new Error('[BymaxLoggerModule] options.service is required')
  }
  if (!options.service.name || options.service.name.trim() === '') {
    throw new Error('[BymaxLoggerModule] options.service.name must be a non-empty string')
  }
  if (!options.service.version || options.service.version.trim() === '') {
    throw new Error('[BymaxLoggerModule] options.service.version must be a non-empty string')
  }
  if (options.level !== undefined && !VALID_LEVELS.includes(options.level)) {
    throw new Error(
      `[BymaxLoggerModule] options.level must be one of: ${VALID_LEVELS.join(', ')}. Got: ${String(options.level)}`
    )
  }
  if (options.maxEntrySizeBytes !== undefined && options.maxEntrySizeBytes <= 0) {
    throw new Error('[BymaxLoggerModule] options.maxEntrySizeBytes must be > 0')
  }
}
```

**Skeleton — `src/server/config/default-options.ts`:**

```typescript
import type {
  BymaxLoggerModuleOptions,
  HttpOptions,
  OtelOptions
} from '../interfaces/logger-module-options.interface'

/**
 * Hard-coded defaults applied when consumer does not override.
 */
const DEFAULT_HTTP: Required<HttpOptions> = {
  isEnabled: false,
  shouldCaptureExceptions: true,
  shouldGenerateRequestId: true,
  excludePaths: [/^\/health$/, /^\/metrics$/],
  tenantIdHeader: 'x-tenant-id'
}

const DEFAULT_OTEL: Required<OtelOptions> = {
  shouldAutoInjectTraceContext: true,
  fieldFormat: 'camelCase',
  traceIdField: 'traceId',
  spanIdField: 'spanId',
  traceFlagsField: 'traceFlags'
}

/**
 * Apply the `fieldFormat` shortcut. Individual `*Field` overrides ALWAYS
 * win — the shortcut only fills the gaps. See OtelOptions JSDoc.
 */
function applyOtelFieldFormat(
  merged: Required<OtelOptions>,
  user: Partial<OtelOptions> | undefined
): Required<OtelOptions> {
  if (merged.fieldFormat === 'snake_case') {
    return {
      ...merged,
      traceIdField: user?.traceIdField ?? 'trace_id',
      spanIdField: user?.spanIdField ?? 'span_id',
      traceFlagsField: user?.traceFlagsField ?? 'trace_flags'
    }
  }
  return merged
}

/**
 * Merges consumer options with library defaults.
 * Returns a deep-frozen object guaranteed to have all optional fields filled.
 */
export function applyDefaults(
  options: BymaxLoggerModuleOptions
): Readonly<Required<BymaxLoggerModuleOptions>> {
  const isProduction = process.env['NODE_ENV'] === 'production'

  const merged: Required<BymaxLoggerModuleOptions> = {
    service: options.service,
    level: options.level ?? (isProduction ? 'info' : 'debug'),
    isGlobal: options.isGlobal ?? true,
    shouldUseAsNestLogger: options.shouldUseAsNestLogger ?? true,
    redactPaths: options.redactPaths ?? [],
    redactCensor: options.redactCensor ?? '[REDACTED]',
    shouldDisableDefaultRedact: options.shouldDisableDefaultRedact ?? false,
    destinations: options.destinations ?? [],
    isPretty: options.isPretty ?? !isProduction,
    http: { ...DEFAULT_HTTP, ...(options.http ?? {}) },
    otel: applyOtelFieldFormat({ ...DEFAULT_OTEL, ...(options.otel ?? {}) }, options.otel),
    maxEntrySizeBytes: options.maxEntrySizeBytes ?? 65_536,
    serializers: options.serializers ?? {},
    timestamp: options.timestamp ?? (() => new Date().toISOString())
  }
  return Object.freeze(merged)
}
```

**Skeleton — `src/server/utils/compile-redact-paths.util.ts`:**

```typescript
import { DEFAULT_REDACT_PATHS } from '../constants/default-redact-paths.constants'

/**
 * Builds the end redact paths list applied to Pino.
 *
 * Behavior:
 *   - If `disableDefault === true`: returns only `extraPaths`
 *   - Otherwise: returns `[...DEFAULT_REDACT_PATHS, ...extraPaths]` deduped
 *
 * Deduplication is necessary because Pino throws on duplicate paths in some
 * versions when `fast-redact` validates the path tree.
 */
export function compileRedactPaths(
  extraPaths: readonly string[],
  disableDefault: boolean
): string[] {
  const sources = disableDefault ? [extraPaths] : [DEFAULT_REDACT_PATHS, extraPaths]
  return Array.from(new Set(sources.flat()))
}
```

**Acceptance criteria:**

- [ ] `validateOptions` throws with a clear message for each invalid case (verifiable in §2.10 tests)
- [ ] `applyDefaults` returns a deep-frozen object (mutation throws in strict mode)
- [ ] `compileRedactPaths(['*.foo'], false)` returns `[...DEFAULT, '*.foo']` deduplicated
- [ ] `compileRedactPaths(['*.foo'], true)` returns only `['*.foo']`
- [ ] `applyDefaults` respects `otel.fieldFormat` shortcut:
  - When unset → defaults to `'camelCase'` (`traceId` / `spanId` / `traceFlags`)
  - When set to `'snake_case'` → defaults are `trace_id` / `span_id` / `trace_flags`
  - Individual `traceIdField` / `spanIdField` / `traceFlagsField` overrides ALWAYS win over the shortcut
- [ ] 100% coverage on these 3 files
- [ ] `pnpm typecheck` passes

**Validation commands:**

```bash
pnpm test src/server/config/  # specific tests will be written in §2.10
pnpm typecheck
```

**Dependencies:** §2.3 (interfaces), §2.4 (constants).

**Risks/Notes:**

- ⚠️ `Object.freeze` is shallow; nested `http` and `otel` also need freezing if we want full immutability — add in §2.10 if mutation testing flags it
- ⚠️ Do not use `zod` — adds an unnecessary dep for simple validation

### 2.6 `DefaultStdoutDestination`

**Goal:** Implement the default destination that writes JSON to `process.stdout`. Registered automatically by the lib.

**Files to create:**

```
src/server/destinations/
└── default-stdout.destination.ts
```

**Skeleton:**

```typescript
import { Injectable } from '@nestjs/common'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { LogLevel } from '../../shared/types/log-level.type'

@Injectable()
export class DefaultStdoutDestination implements ILogDestination {
  readonly name = 'stdout-json'
  readonly minLevel?: LogLevel

  constructor(opts: { minLevel?: LogLevel } = {}) {
    this.minLevel = opts.minLevel
  }

  write(payload: string): void {
    // process.stdout.write is buffered by Node; safe for high throughput.
    // For sync drain on crash, use process.stdout.write(payload, () => {}).
    process.stdout.write(payload)
  }
}
```

**Acceptance criteria:**

- [ ] Class implements `ILogDestination` correctly
- [ ] `write()` calls `process.stdout.write` (verifiable via spy)
- [ ] Supports `minLevel` via constructor option
- [ ] 100% coverage (Stryker will catch remaining gaps via mutation score)

**Validation commands:**

```bash
pnpm test src/server/destinations/default-stdout.destination.spec.ts
```

**Dependencies:** §2.3.

### 2.7 `PinoLoggerService` — base

**Goal:** Base implementation of `PinoLoggerService` covering:

- Constructor taking options + Pino instance
- NestJS methods (`log`, `error`, `warn`, `debug`, `verbose`, `fatal`)
- Structured API (`info`, `warnStructured`, `errorStructured`)
- `setContext()`, `getRawLogger()`

**Not yet:** `child()`, AsyncLocalStorage merge, trace context (come in Phase 2).

**Files to create:**

```
src/server/services/
└── pino-logger.service.ts
```

**Skeleton:**

```typescript
import {
  Inject,
  Injectable,
  LoggerService as NestLoggerService,
  OnApplicationShutdown
} from '@nestjs/common'
import type { Logger as PinoLogger } from 'pino'
import { LOGGER_PINO_INSTANCE_TOKEN } from '../constants/injection-tokens.constants'

/**
 * NestJS logger service backed by Pino 10.
 *
 * Implements the official `LoggerService` interface (variadic signatures using
 * `any` — required for type compatibility with `app.useLogger()`) AND adds a
 * structured API following the `MODULE_ACTION_RESULT` convention.
 *
 * See `docs/technical_specification.md` §6.1 for the full API surface.
 */
@Injectable()
export class PinoLoggerService implements NestLoggerService, OnApplicationShutdown {
  private context?: string

  constructor(@Inject(LOGGER_PINO_INSTANCE_TOKEN) private readonly pino: PinoLogger) {}

  // ─── NestJS LoggerService variadic interface ────────────────────────────

  log(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('info', message, optionalParams)
  }

  error(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('error', message, optionalParams)
  }

  warn(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('warn', message, optionalParams)
  }

  debug(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('debug', message, optionalParams)
  }

  verbose(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('trace', message, optionalParams)
  }

  // `fatal` is declared NON-OPTIONAL on PinoLoggerService (Pino supports it
  // natively at level 60). NestJS `LoggerService` types it as `fatal?` —
  // implementing it as a required method is still type-compatible because
  // we widen the contract, not narrow it.
  fatal(message: any, ...optionalParams: any[]): void {
    this.emitNestStyle('fatal', message, optionalParams)
  }

  // ─── Structured API ─────────────────────────────────────────────────────

  /**
   * Emit an info log following MODULE_ACTION_RESULT convention.
   *
   * @example
   *   logger.info('USER_CREATED', 'New user registered', userId, { plan: 'pro' })
   */
  info(logKey: string, message: string, userId?: string, metadata?: Record<string, unknown>): void {
    this.emitStructured('info', logKey, message, userId, metadata)
  }

  warnStructured(
    logKey: string,
    message: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.emitStructured('warn', logKey, message, userId, metadata)
  }

  errorStructured(
    logKey: string,
    error: Error,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.pino.error(
      {
        logKey,
        userId,
        context: this.context,
        err: { name: error.name, message: error.message, stack: error.stack },
        ...metadata
      },
      error.message
    )
  }

  // ─── Helpers / escape hatches ───────────────────────────────────────────

  setContext(context: string): void {
    this.context = context
  }

  getRawLogger(): PinoLogger {
    return this.pino
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async onApplicationShutdown(): Promise<void> {
    // Pino flush is fire-and-forget; end destination flush handled by DestinationRegistry
    // (introduced in Phase 4).
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private emitStructured(
    level: 'info' | 'warn',
    logKey: string,
    message: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.pino[level]({ logKey, userId, context: this.context, ...metadata }, message)
  }

  private emitNestStyle(
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal',
    message: any,
    optionalParams: any[]
  ): void {
    // NestJS variadic: error(msg, trace?, context?), info(msg, context?), etc.
    const context =
      typeof optionalParams[optionalParams.length - 1] === 'string'
        ? (optionalParams[optionalParams.length - 1] as string)
        : this.context

    const payload: Record<string, unknown> = { context }
    if (level === 'error' && typeof optionalParams[0] === 'string') {
      payload['stack'] = optionalParams[0]
    }
    this.pino[level](payload, String(message))
  }
}
```

**Acceptance criteria:**

- [ ] Implements `LoggerService` (verifiable via type-check with `app.useLogger(loggerService)`)
- [ ] Structured `info()` produces JSON containing `logKey`, `msg`, `userId` (when provided)
- [ ] `errorStructured()` serializes Error with `err.name`, `err.message`, `err.stack`
- [ ] `setContext()` applies `context` to subsequent logs
- [ ] `getRawLogger()` returns the internal Pino instance
- [ ] 100% coverage
- [ ] Mutation score ≥ 99% on this class (critical path)

**Validation commands:**

```bash
pnpm test src/server/services/pino-logger.service.spec.ts
pnpm test:cov  # 95% gate for this file
```

**Dependencies:** §2.3 (interfaces), §2.4 (token).

**Risks/Notes:**

- ⚠️ `any` in NestJS signatures is required (see spec §6.1 note)
- ⚠️ `emitNestStyle` "last string param = context" heuristic mirrors nest-winston / nestjs-pino behavior — keep consistent
- ⚠️ Do not use `child()` yet — implemented in Phase 2 where it integrates with AsyncLocalStorage

### 2.8 Sync `BymaxLoggerModule.forRoot()`

**Goal:** Implement the NestJS dynamic module — sync only at this phase. `forRootAsync()` comes in §5.4 of Phase 4.

> **Task split — LOG-024a / LOG-024b (E12):**
> This sub-step previously bundled the builder + sync `forRoot()` + async `forRootAsync()` + bootstrap log under one 100% coverage gate. To shrink blast radius and surface failures earlier, `development_tasks.md` splits it into:
>
> - **LOG-024a** — builder skeleton (`logger.module.builder.ts`) + sync `forRoot()` providers (Pino instance, destinations, `PinoLoggerService`) + 100% coverage on the sync path.
> - **LOG-024b** — `forRootAsync()` factory providers + bootstrap log emission after options resolve + 100% coverage on the async path.
>
> LOG-024b depends on LOG-024a. The bootstrap log appears in **both** paths but is exercised by tests independently.

**Files to create:**

```
src/server/
├── logger.module.builder.ts   # ConfigurableModuleBuilder factory
├── logger.module.ts           # BymaxLoggerModule extends the builder base
└── pino-factory.ts            # buildPinoInstance(options) — Phase 1; receives LogContextService in Phase 2
```

**Skeleton — `src/server/pino-factory.ts`:**

```typescript
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { compileRedactPaths } from './utils/compile-redact-paths.util'

/**
 * Builds a configured Pino instance from validated options.
 * Multi-stream (stdout + extra destinations) is wired in Phase 4 via
 * `DestinationRegistry`. For Phase 1, single stdout output via DefaultStdoutDestination
 * is used directly.
 *
 * Phase 2 adds the `mixin` parameter for AsyncLocalStorage + OTel trace context
 * injection — see plan §3.4.
 */
export function buildPinoInstance(options: Required<BymaxLoggerModuleOptions>): PinoLogger {
  const pinoOpts: LoggerOptions = {
    level: options.level,
    redact: {
      paths: compileRedactPaths(options.redactPaths, options.shouldDisableDefaultRedact),
      censor: options.redactCensor
    },
    base: { service: options.service },
    timestamp: () => `,"time":"${options.timestamp()}"`,
    formatters: {
      // emit string level instead of number — easier for log aggregators
      level: (label, _number) => ({ level: label })
      // NOTE: do NOT use formatters.log to inject traceId/spanId — that hook only
      // sees what the caller passed to pino.info(obj, msg). Trace context comes
      // from ambient OTel + ALS — wired via `mixin` (Phase 2, plan §3.3).
    },
    serializers: {
      err: pino.stdSerializers.err,
      // `req` and `res` are NOT default Pino serializers — they're opt-in.
      // Phase 3 HTTP interceptor adds them via `pino.stdSerializers.req/res` when
      // `http.isEnabled: true`. Until then, leave out to avoid false impression.
      ...options.serializers
    }
  }

  return pino(pinoOpts)
}
```

**Skeleton — `src/server/logger.module.builder.ts` (Phase 1, depends on §2.4 constants):**

```typescript
import { ConfigurableModuleBuilder } from '@nestjs/common'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { LOGGER_OPTIONS_TOKEN } from './constants/injection-tokens.constants'

/**
 * Configurable module factory — produces the base class implementing
 * `forRoot()` and `forRootAsync()` automatically.
 *
 * IMPORTANT: this builder REUSES the `LOGGER_OPTIONS_TOKEN` declared in
 * `constants/injection-tokens.constants.ts` (instead of taking ownership of
 * `MODULE_OPTIONS_TOKEN`). The builder is provided the symbol via the
 * `.setOptionsType()` + manual provider plumbing below. This breaks the
 * §2.4 → §2.8 ordering coupling (E11 fix, option 2).
 *
 * @see https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder
 */
export const {
  ConfigurableModuleClass: BymaxLoggerModuleBase,
  MODULE_OPTIONS_TOKEN: BUILDER_OPTIONS_TOKEN, // builder-generated token; we re-provide as LOGGER_OPTIONS_TOKEN
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE
} = new ConfigurableModuleBuilder<BymaxLoggerModuleOptions>()
  .setClassMethodName('forRoot') // also emits `forRootAsync`
  .setExtras<{ isGlobal?: boolean }>({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal ?? true
  }))
  .build()

// Re-export the canonical token under its public name so downstream code
// continues to read `LOGGER_OPTIONS_TOKEN` from one place. Internal code in
// `logger.module.ts` registers an alias provider:
//   { provide: LOGGER_OPTIONS_TOKEN, useExisting: BUILDER_OPTIONS_TOKEN }
// so both tokens resolve to the same value. Tests assert that
// `module.get(LOGGER_OPTIONS_TOKEN) === module.get(BUILDER_OPTIONS_TOKEN)`.
export { LOGGER_OPTIONS_TOKEN }

// Public-API note: consumers pass `isGlobal: boolean` (NOT `global:`) on
// `BymaxLoggerModuleOptions`. The builder's `setExtras` maps it to the
// internal `DynamicModule.global` flag NestJS requires.

// `LOGGER_OPTIONS_TOKEN` is now exported from here — substitutes the manual
// Symbol() declared in constants/injection-tokens.constants.ts (kept there for
// backward-compat re-export).
```

**Skeleton — `src/server/logger.module.ts`:**

```typescript
import { DynamicModule, Module } from '@nestjs/common'
import type { OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } from './logger.module.builder'
import { BymaxLoggerModuleBase, LOGGER_OPTIONS_TOKEN } from './logger.module.builder'
import { validateOptions } from './config/validate-options'
import { applyDefaults } from './config/default-options'
import { buildPinoInstance } from './pino-factory'
import { PinoLoggerService } from './services/pino-logger.service'
import { DefaultStdoutDestination } from './destinations/default-stdout.destination'
import {
  LOGGER_PINO_INSTANCE_TOKEN,
  LOGGER_DESTINATIONS_TOKEN
} from './constants/injection-tokens.constants'
import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

@Module({})
export class BymaxLoggerModule extends BymaxLoggerModuleBase {
  /**
   * Synchronous configuration.
   *
   * @example
   *   BymaxLoggerModule.forRoot({
   *     service: { name: 'my-app', version: '1.0.0' },
   *     level: 'info',
   *   })
   */
  static override forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    const base = super.forRoot(options)
    return this.augment(base, options)
  }

  static override forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    const base = super.forRootAsync(options)
    return this.augment(base, undefined)
  }

  private static augment(
    base: DynamicModule,
    options: typeof OPTIONS_TYPE | undefined
  ): DynamicModule {
    // Sync path: we know options now; precompute pino instance + destinations.
    // Async path: defer to a factory provider that runs after MODULE_OPTIONS_TOKEN resolves.
    const extraProviders =
      options !== undefined ? buildSyncProviders(options) : buildAsyncProviders()

    return {
      ...base,
      providers: [...(base.providers ?? []), ...extraProviders, PinoLoggerService],
      exports: [
        ...(base.exports ?? []),
        PinoLoggerService,
        LOGGER_OPTIONS_TOKEN,
        LOGGER_PINO_INSTANCE_TOKEN,
        LOGGER_DESTINATIONS_TOKEN
      ]
    }
  }
}

function buildSyncProviders(options: typeof OPTIONS_TYPE): Provider[] {
  validateOptions(options)
  const resolved = applyDefaults(options)
  const pino = buildPinoInstance(resolved)
  const destinations =
    resolved.destinations.length > 0 ? resolved.destinations : [new DefaultStdoutDestination()]
  pino.info(
    { logKey: RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK, level: resolved.level },
    'Logger initialized'
  )
  return [
    { provide: LOGGER_PINO_INSTANCE_TOKEN, useValue: pino },
    { provide: LOGGER_DESTINATIONS_TOKEN, useValue: destinations }
  ]
}

function buildAsyncProviders(): Provider[] {
  return [
    {
      provide: LOGGER_PINO_INSTANCE_TOKEN,
      inject: [LOGGER_OPTIONS_TOKEN],
      useFactory: (options: BymaxLoggerModuleOptions) => {
        validateOptions(options)
        const resolved = applyDefaults(options)
        const pino = buildPinoInstance(resolved)
        pino.info(
          { logKey: RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK, level: resolved.level },
          'Logger initialized'
        )
        return pino
      }
    },
    {
      provide: LOGGER_DESTINATIONS_TOKEN,
      inject: [LOGGER_OPTIONS_TOKEN],
      useFactory: (options: BymaxLoggerModuleOptions) => {
        const resolved = applyDefaults(options)
        return resolved.destinations.length > 0
          ? resolved.destinations
          : [new DefaultStdoutDestination()]
      }
    }
  ]
}
```

> **Key points:**
>
> 1. `ConfigurableModuleBuilder` generates the `forRoot`/`forRootAsync` boilerplate. We override only to **add our providers** (Pino instance, destinations, service).
> 2. `LOGGER_OPTIONS_TOKEN` is OWNED by `constants/injection-tokens.constants.ts` (manual `Symbol.for`) — E11 fix. The builder file imports it from there and aliases its internal `MODULE_OPTIONS_TOKEN` via a `useExisting` provider so both resolve to the same value.
> 3. **Sync vs Async**: in the sync path, we call `buildPinoInstance` on the spot; in the async path, we create a factory provider that depends on `LOGGER_OPTIONS_TOKEN`.
> 4. `setExtras` controls the `isGlobal` flag (default `true`) — replaces the manual `@Global()` decorator.

**Acceptance criteria:**

- [ ] `BymaxLoggerModule.forRoot(options)` returns a `DynamicModule`
- [ ] Provides `PinoLoggerService` injectable in any other module
- [ ] Provides tokens `LOGGER_OPTIONS_TOKEN`, `LOGGER_PINO_INSTANCE_TOKEN`, `LOGGER_DESTINATIONS_TOKEN`
- [ ] `options.isGlobal: true` (default) makes the module global (verifiable in e2e)
- [ ] Bootstrap log `LOGGER_BOOTSTRAP_OK` is emitted with level and options summary
- [ ] 100% coverage in `logger.module.ts` and `pino-factory.ts`

**Validation commands:**

```bash
pnpm test src/server/logger.module.spec.ts
pnpm test src/server/pino-factory.spec.ts
```

**Dependencies:** §2.3, §2.4, §2.5, §2.6, §2.7.

**Risks/Notes:**

- ⚠️ The bootstrap log uses `pino.info()` directly (without PinoLoggerService) — because the service has not been injected yet at this point
- ⚠️ When `destinations.length > 0`, the lib still needs to ensure **at least one** active destination receives logs — in Phase 1, `pino()` defaults to writing to `process.stdout`; in Phase 4, multi-stream via `DestinationRegistry` replaces this

### 2.9 Barrel export `src/server/index.ts`

**Goal:** Expose the official public API of the server subpath.

**Files to create/modify:**

- `src/server/index.ts`

**Skeleton:**

```typescript
// Module
export { BymaxLoggerModule } from './logger.module'

// Services
export { PinoLoggerService } from './services/pino-logger.service'

// Destinations
export { DefaultStdoutDestination } from './destinations/default-stdout.destination'

// Interfaces
export type {
  ILogDestination,
  LogContext,
  BymaxLoggerModuleOptions,
  BymaxLoggerModuleAsyncOptions,
  BymaxLoggerModuleOptionsFactory,
  HttpOptions,
  OtelOptions
} from './interfaces'

// DI tokens
export {
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN,
  LOGGER_DESTINATIONS_TOKEN,
  LOG_CONTEXT_TOKEN
} from './constants/injection-tokens.constants'

// Constants
export { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'

// Re-export from shared for convenience
export type { LogLevel, LogEntry, ServiceMetadata } from '../shared'
export { LOG_KEYS_CONVENTION_REGEX, RESERVED_LOG_KEYS } from '../shared'
```

**Acceptance criteria:**

- [ ] All public symbols exported
- [ ] `pnpm build` produces `dist/server/index.{mjs,cjs,d.ts}`
- [ ] `node -e "import('./dist/server/index.mjs').then(m => Object.keys(m).forEach(console.log))"` lists all expected exports
- [ ] In the `_internal*` symbol or internal implementation leaks

**Validation commands:**

```bash
pnpm build
node -e "import('./dist/server/index.mjs').then(m => console.log(Object.keys(m).sort()))"
```

**Dependencies:** §2.3 through §2.8.

### 2.10 Phase 1 tests

**Goal:** Reach 100% coverage on the Phase 1 files (`pino-logger.service.ts`, `validate-options.ts`, `compile-redact-paths.util.ts`, `default-options.ts`, `default-stdout.destination.ts`).

**Files to create (test structure):**

```
src/
├── server/
│   ├── services/
│   │   └── pino-logger.service.spec.ts
│   ├── config/
│   │   ├── validate-options.spec.ts
│   │   └── default-options.spec.ts
│   ├── utils/
│   │   └── compile-redact-paths.util.spec.ts
│   ├── destinations/
│   │   └── default-stdout.destination.spec.ts
│   ├── pino-factory.spec.ts
│   └── logger.module.spec.ts
└── shared/
    └── constants/
        ├── log-keys-convention.constants.spec.ts
        └── reserved-log-keys.constants.spec.ts
```

**AAA pattern + descriptive name:**

Every `it()` follows:

```typescript
it('should <do something> when <condition>', () => {
  // Arrange — setup
  // Act     — execute
  // Assert  — verify
})
```

**Critical cases per file:**

#### `pino-logger.service.spec.ts`

```typescript
describe('PinoLoggerService', () => {
  let service: PinoLoggerService
  let mockPino: jest.Mocked<PinoLogger>

  beforeEach(async () => {
    mockPino = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      level: 'info'
    } as never

    const module = await Test.createTestingModule({
      providers: [PinoLoggerService, { provide: LOGGER_PINO_INSTANCE_TOKEN, useValue: mockPino }]
    }).compile()

    service = module.get(PinoLoggerService)
  })

  describe('structured API', () => {
    it('should emit info log with logKey, message, userId and metadata', () => {
      service.info('USER_CREATED', 'Created', 'u_1', { plan: 'pro' })
      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({ logKey: 'USER_CREATED', userId: 'u_1', plan: 'pro' }),
        'Created'
      )
    })

    it('should emit error with err.stack, err.message, err.name', () => {
      const err = new Error('boom')
      service.errorStructured('PAYMENT_FAILED', err, 'u_1', { paymentId: 'p_1' })
      expect(mockPino.error).toHaveBeenCalledWith(
        expect.objectContaining({
          logKey: 'PAYMENT_FAILED',
          userId: 'u_1',
          paymentId: 'p_1',
          err: { name: 'Error', message: 'boom', stack: expect.any(String) }
        }),
        'boom'
      )
    })
  })

  describe('NestJS variadic interface', () => {
    it('should emit info via log(message)', () => {
      service.log('hello')
      expect(mockPino.info).toHaveBeenCalledWith(expect.any(Object), 'hello')
    })

    it('should treat last string param as context override', () => {
      service.log('hello', 'UsersService')
      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'UsersService' }),
        'hello'
      )
    })
  })

  describe('setContext', () => {
    it('should apply context to subsequent logs', () => {
      service.setContext('UsersService')
      service.info('USER_X', 'msg')
      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'UsersService' }),
        'msg'
      )
    })
  })

  describe('getRawLogger', () => {
    it('should return the internal Pino instance', () => {
      expect(service.getRawLogger()).toBe(mockPino)
    })
  })

  describe('onApplicationShutdown', () => {
    it('should resolve without throwing', async () => {
      await expect(service.onApplicationShutdown()).resolves.toBeUndefined()
    })
  })
})
```

#### `validate-options.spec.ts`

```typescript
describe('validateOptions', () => {
  const validOpts: BymaxLoggerModuleOptions = {
    service: { name: 'app', version: '1.0.0' }
  }

  it('should accept valid minimal options', () => {
    expect(() => validateOptions(validOpts)).not.toThrow()
  })

  it.each([
    ['undefined service', { ...validOpts, service: undefined as never }],
    ['empty service.name', { ...validOpts, service: { name: '', version: '1.0.0' } }],
    ['whitespace service.name', { ...validOpts, service: { name: '  ', version: '1.0.0' } }],
    ['empty service.version', { ...validOpts, service: { name: 'app', version: '' } }]
  ])('should throw when %s', (_label, opts) => {
    expect(() => validateOptions(opts)).toThrow(/service/i)
  })

  it('should throw when level is invalid', () => {
    expect(() => validateOptions({ ...validOpts, level: 'verbose' as never })).toThrow(/level/i)
  })

  it('should throw when maxEntrySizeBytes is zero or negative', () => {
    expect(() => validateOptions({ ...validOpts, maxEntrySizeBytes: 0 })).toThrow(
      /maxEntrySizeBytes/
    )
    expect(() => validateOptions({ ...validOpts, maxEntrySizeBytes: -1 })).toThrow(
      /maxEntrySizeBytes/
    )
  })
})
```

#### `compile-redact-paths.util.spec.ts`

```typescript
describe('compileRedactPaths', () => {
  it('should merge defaults with extras', () => {
    const result = compileRedactPaths(['*.custom'], false)
    expect(result).toContain('*.password')
    expect(result).toContain('*.custom')
  })

  it('should dedupe entries present in both lists', () => {
    const result = compileRedactPaths(['*.password'], false)
    const count = result.filter((p) => p === '*.password').length
    expect(count).toBe(1)
  })

  it('should return only extras when disableDefault is true', () => {
    const result = compileRedactPaths(['*.only'], true)
    expect(result).toEqual(['*.only'])
    expect(result).not.toContain('*.password')
  })

  it('should return empty array when in the extras and disableDefault', () => {
    expect(compileRedactPaths([], true)).toEqual([])
  })
})
```

#### `default-stdout.destination.spec.ts`

```typescript
describe('DefaultStdoutDestination', () => {
  let dest: DefaultStdoutDestination
  let writeSpy: jest.SpyInstance

  beforeEach(() => {
    dest = new DefaultStdoutDestination()
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  it('should expose name "stdout-json"', () => {
    expect(dest.name).toBe('stdout-json')
  })

  it('should write payload to process.stdout', () => {
    dest.write('{"level":30}\n')
    expect(writeSpy).toHaveBeenCalledWith('{"level":30}\n')
  })

  it('should accept and store minLevel option', () => {
    const customDest = new DefaultStdoutDestination({ minLevel: 'warn' })
    expect(customDest.minLevel).toBe('warn')
  })
})
```

#### `logger.module.spec.ts`

```typescript
describe('BymaxLoggerModule', () => {
  it('should register PinoLoggerService as injectable', async () => {
    const module = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'test', version: '1.0.0' }
        })
      ]
    }).compile()

    const logger = module.get(PinoLoggerService)
    expect(logger).toBeInstanceOf(PinoLoggerService)
  })

  it('should throw when options are invalid', () => {
    expect(() =>
      BymaxLoggerModule.forRoot({ service: { name: '', version: '1.0.0' } } as never)
    ).toThrow(/service\.name/)
  })

  it('should be global by default', () => {
    const module = BymaxLoggerModule.forRoot({
      service: { name: 'test', version: '1.0.0' }
    })
    expect(module.global).toBe(true)
  })

  it('should respect isGlobal: false option', () => {
    const module = BymaxLoggerModule.forRoot({
      service: { name: 'test', version: '1.0.0' },
      isGlobal: false
    })
    expect(module.global).toBe(false)
  })
})
```

**Acceptance criteria:**

- [ ] All `.spec.ts` files listed are created
- [ ] `pnpm test:cov` reports **100% coverage** on every Phase 1 file
- [ ] Per-file coverage (all require 100%):
  - `pino-logger.service.ts`: 100%
  - `validate-options.ts`: 100%
  - `compile-redact-paths.util.ts`: 100%
  - `default-options.ts`: 100%
- [ ] `pnpm test` zero failures
- [ ] `clearMocks: true` and `restoreMocks: true` honored (no spillover between tests)

**Validation commands:**

```bash
pnpm test:cov
# Expected output:
# Statements: 100% (per-file gate in jest.config.ts; global gate in jest.coverage.config.ts)
# All tests passing
```

**Dependencies:** §2.7, §2.8 (code to test).

**Risks/Notes:**

- ⚠️ Mocking `process.stdout.write` requires `mockRestore()` in `afterEach` to avoid leakage between suites
- ⚠️ `Test.createTestingModule` from `@nestjs/testing` is the standard; do not roll your own container

### 2.11 Phase 1 validation

**Final commands to validate the phase:**

```bash
# 1. Type safety
pnpm typecheck

# 2. Lint
pnpm lint

# 3. Tests + coverage
pnpm test:cov

# 4. Build
pnpm build

# 5. Bundle size
pnpm size

# 6. Smoke test — import and use the lib in a script
cat <<'EOF' > /tmp/smoke-test.mjs
import { BymaxLoggerModule, PinoLoggerService } from './dist/server/index.mjs'
import { LOG_KEYS_CONVENTION_REGEX } from './dist/shared/index.mjs'

console.log('Module class:', BymaxLoggerModule.name)
console.log('Service class:', PinoLoggerService.name)
console.log('Regex valid for USER_CREATED:', LOG_KEYS_CONVENTION_REGEX.test('USER_CREATED'))
EOF
node /tmp/smoke-test.mjs
```

**Expected:**

```
PASS  src/server/services/pino-logger.service.spec.ts
PASS  src/server/config/validate-options.spec.ts
... (all)

Tests:       N passed, N total
Coverage:    Statements 100% / Branches 100% / Functions 100% / Lines 100%

Module class: BymaxLoggerModule
Service class: PinoLoggerService
Regex valid for USER_CREATED: true
```

**Done criteria for closing Phase 1:**

- [ ] All commands above pass
- [ ] Coverage thresholds met
- [ ] `git status` clean after commits with Conventional Commits (`feat(logger): scaffold project structure`, `feat(logger): add shared types and constants`, `feat(logger): implement PinoLoggerService base`, etc.)
- [ ] `/bymax-quality:code-review` run and findings applied — **no CRITICAL or HIGH findings unresolved before merge** (quantitative gate, applies to every phase per §1.4)
- [ ] CHANGELOG `[Unreleased]` entry appended per PR (per §1.4)
- [ ] Pull request opened with label `phase-1`

---

## 3. Phase 2 — Context Propagation + OpenTelemetry Mixin

> **Phase goal:** Add automatic context propagation (`requestId`, `tenantId`, `userId`) via `AsyncLocalStorage` and optional `traceId`/`spanId` injection when OpenTelemetry is active. At the end, every log emitted inside an HTTP request carries the identifiers without prop drilling.
>
> **Complexity:** MEDIUM.
>
> **Critical paths (mutation 100% required):** `src/server/services/log-context.service.ts`, `src/server/utils/otel-detector.ts`, `src/server/mixins/trace-context.mixin.ts`. Coverage for **every** file in the phase: **100%**.

### 3.1 `LogContextService` — AsyncLocalStorage manager

**Goal:** Wrap `AsyncLocalStorage<LogContext>` in an injectable NestJS service.

**Files to create:**

```
src/server/services/log-context.service.ts
```

**Skeleton:**

```typescript
import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogContext } from '../interfaces/log-context.interface'

@Injectable()
export class LogContextService {
  private readonly als = new AsyncLocalStorage<LogContext>()

  /**
   * Execute callback inside a context scope. All logs emitted synchronously OR
   * asynchronously within the callback inherit the context.
   *
   * @example
   *   logContext.run({ requestId: 'r_1', tenantId: 't_1' }, async () => {
   *     await userService.create(dto)  // logs inside will carry requestId + tenantId
   *   })
   */
  run<T>(context: LogContext, callback: () => T): T {
    return this.als.run(context, callback)
  }

  /**
   * Retrieve the current context, or `undefined` if outside any scope.
   */
  getStore(): LogContext | undefined {
    return this.als.getStore()
  }

  /**
   * Add or override a field in the current context.
   * Mutates the active store; throws if called outside a `run()` scope.
   */
  set(key: string, value: unknown): void {
    const store = this.als.getStore()
    if (!store) {
      throw new Error('[LogContextService] set() called outside run() scope')
    }
    store[key] = value
  }

  /**
   * Read a single field from the current context.
   */
  get<T = unknown>(key: string): T | undefined {
    return this.als.getStore()?.[key] as T | undefined
  }
}
```

**Acceptance criteria:**

- [ ] `run()` propagates context to sync and async callbacks (verify with `setTimeout`, `await`, Promise.all)
- [ ] `getStore()` outside `run()` returns `undefined`
- [ ] `set()` outside scope throws Error
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/services/log-context.service.spec.ts
```

**Dependencies:** §2.3 (interface `LogContext`).

### 3.2 OTel detector (`otel-detector.ts`)

**Goal:** Optionally detect `@opentelemetry/api`. Works in ESM and CJS.

**Files to create:**

```
src/server/utils/otel-detector.ts
```

**Skeleton:**

```typescript
import { createRequire } from 'node:module'

/**
 * Subset of `@opentelemetry/api` we depend on. Typed locally so the lib
 * doesn't require `@opentelemetry/api` at compile time when running in a
 * project without it.
 */
export interface OtelTraceApi {
  getActiveSpan():
    | {
        spanContext(): { traceId: string; spanId: string; traceFlags: number }
      }
    | undefined
}

/**
 * Lazily resolve `@opentelemetry/api`.
 *
 * @returns The `trace` API if installed, or `undefined`.
 */
export function detectOtelTraceApi(): OtelTraceApi | undefined {
  try {
    // `import.meta.url` resolves correctly in both ESM source and tsup-bundled CJS.
    const requireFromHere = createRequire(import.meta.url)
    const mod = requireFromHere('@opentelemetry/api')
    return mod?.trace as OtelTraceApi | undefined
  } catch {
    return undefined
  }
}

/**
 * Check whether a span has a valid (non-zero) trace ID.
 * OTel uses '0' x 32 as the "no trace" sentinel.
 */
export function isValidTraceId(traceId: string): boolean {
  return traceId.length === 32 && !/^0+$/.test(traceId)
}
```

**Acceptance criteria:**

- [ ] `detectOtelTraceApi()` returns `undefined` when `@opentelemetry/api` is not in node_modules (mock via jest)
- [ ] `detectOtelTraceApi()` returns the API when the module is available
- [ ] `isValidTraceId('0000000000000000000000000000000000')` returns `false` (more than 32 chars — also invalid)
- [ ] `isValidTraceId('00000000000000000000000000000000')` returns `false` (zeros only)
- [ ] `isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736')` returns `true`
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/utils/otel-detector.spec.ts
```

**Dependencies:** §2.1 (Node 24+).

**Risks/Notes:**

- ⚠️ `createRequire(import.meta.url)` works in ESM **and** after tsup transforms to CJS (tsup injects a shim). Validate both `dist/.../index.mjs` and `dist/.../index.cjs`.

### 3.3 `TraceContextMixin` — Pino formatter

**Goal:** Pino mixin that merges `traceId`/`spanId` from the active span into each log entry.

**Files to create:**

```
src/server/mixins/trace-context.mixin.ts
```

**Skeleton:**

```typescript
import { detectOtelTraceApi, isValidTraceId, type OtelTraceApi } from '../utils/otel-detector'
import type { LogContextService } from '../services/log-context.service'
import type { Logger as PinoLogger } from 'pino'

/**
 * Creates a Pino mixin function that:
 *   1. Merges LogContext (requestId, tenantId, userId) from AsyncLocalStorage
 *   2. Merges trace context (traceId, spanId, traceFlags) from active OpenTelemetry span (if available)
 *
 * The mixin is called by Pino for every log entry, before redact paths apply.
 * Signature follows Pino 10 official mixin contract: (mergeObject, level, logger) => object.
 * The first 2 args are unused by this mixin but MUST appear in the type to satisfy Pino.
 *
 * Field names for trace context are configurable via OtelOptions:
 *   - traceIdField / spanIdField / traceFlagsField (default 'traceId' / 'spanId' / 'traceFlags' — camelCase)
 *   - To align with the snake_case wire format of @opentelemetry/instrumentation-pino,
 *     set fields to 'trace_id' / 'span_id' / 'trace_flags' (also configurable on the consumer side).
 *
 * @see https://github.com/pinojs/pino/blob/main/docs/api.md#mixin-function
 */
export function createTraceContextMixin(
  logContext: LogContextService,
  opts: {
    traceIdField: string
    spanIdField: string
    traceFlagsField: string
    shouldAutoInjectTraceContext: boolean
  }
): (
  mergeObject: Record<string, unknown>,
  level: number,
  logger: PinoLogger
) => Record<string, unknown> {
  const traceApi: OtelTraceApi | undefined = opts.shouldAutoInjectTraceContext
    ? detectOtelTraceApi()
    : undefined

  return function mixin(
    _mergeObject: Record<string, unknown>,
    _level: number,
    _logger: PinoLogger
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {}

    // 1. AsyncLocalStorage context (requestId, tenantId, userId, ...)
    const store = logContext.getStore()
    if (store) {
      Object.assign(merged, store)
    }

    // 2. OTel trace context (overrides store values if both present)
    if (traceApi) {
      const span = traceApi.getActiveSpan()
      if (span) {
        const ctx = span.spanContext()
        if (ctx?.traceId && isValidTraceId(ctx.traceId)) {
          merged[opts.traceIdField] = ctx.traceId
          merged[opts.spanIdField] = ctx.spanId
          // traceFlags as 2-hex-digit lowercase per W3C Trace Context spec
          if (typeof ctx.traceFlags === 'number') {
            merged[opts.traceFlagsField] = ctx.traceFlags.toString(16).padStart(2, '0')
          }
        }
      }
    }

    return merged
  }
}
```

**Acceptance criteria:**

- [ ] Mixin returns `{}` when there is in the context and in the OTel
- [ ] Mixin returns `{ requestId, tenantId, userId }` when there is a LogContext
- [ ] Mixin returns `{ traceId, spanId }` when there is an active OTel span
- [ ] Mixin does **not** throw when `traceApi` is `undefined`
- [ ] Mixin does **not** inject trace fields when `shouldAutoInjectTraceContext: false`
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/mixins/trace-context.mixin.spec.ts
```

**Dependencies:** §3.1, §3.2.

**Risks/Notes:**

- ⚠️ Default fields are `traceId`/`spanId`/`traceFlags` (camelCase, Pino-native). To align with OTel Logs Data Model (`trace_id`/`span_id`/`trace_flags` snake_case in the wire format), the consumer can pass `otel.traceIdField: 'trace_id'`, `otel.spanIdField: 'span_id'`, `otel.traceFlagsField: 'trace_flags'` or just align the `PinoInstrumentation` `logKeys` if both are used together. Recommended: use **only** this lib's mixin (avoids duplication).

### 3.4 Mixin integration in `pino-factory`

**Goal:** `buildPinoInstance` receives `LogContextService` (via DI) and installs the mixin.

**Files to modify:**

```
src/server/pino-factory.ts
src/server/logger.module.ts
```

**Modification — `pino-factory.ts`:**

```typescript
// Add parameter
export function buildPinoInstance(
  options: Required<BymaxLoggerModuleOptions>,
  logContext: LogContextService
): PinoLogger {
  const pinoOpts: LoggerOptions = {
    // ... as before ...
    mixin: createTraceContextMixin(logContext, options.otel)
    // ...
  }
  return pino(pinoOpts)
}
```

**Modification — `logger.module.ts`:**

```typescript
// Provider for LogContextService FIRST (no dep), then the Pino factory can use it
const logContext = new LogContextService()
const pino = buildPinoInstance(resolved, logContext)

providers.push(
  { provide: LogContextService, useValue: logContext }
  // rest as before
)

exports.push(LogContextService)
```

**Acceptance criteria:**

- [ ] A log emitted outside `logContext.run(...)` has in the `requestId`/`tenantId`/`userId`
- [ ] A log emitted inside `logContext.run({ requestId: 'r_1' }, ...)` carries `requestId: 'r_1'`
- [ ] A log emitted with an active OTel span carries a valid `traceId` (32 hex chars)
- [ ] A log emitted with a "no-op" OTel span (traceId 0x32) does **not** carry `traceId`
- [ ] 100% coverage in `pino-factory.ts`

**Validation commands:**

```bash
pnpm test
pnpm test:cov
```

**Dependencies:** §3.3, §2.8.

### 3.5 `RequestIdMiddleware`

**Goal:** NestJS middleware that generates/reads `x-request-id` and starts `logContext.run({ requestId, tenantId }, next)`.

**Files to create:**

```
src/server/middlewares/request-id.middleware.ts
```

**Skeleton:**

```typescript
import { Inject, Injectable, NestMiddleware } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { LogContextService } from '../services/log-context.service'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly tenantIdHeader: string

  constructor(
    private readonly logContext: LogContextService,
    @Inject(LOGGER_OPTIONS_TOKEN) options: Required<BymaxLoggerModuleOptions>
  ) {
    this.tenantIdHeader = options.http.tenantIdHeader
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
    res.setHeader('x-request-id', requestId)

    const tenantId = req.headers[this.tenantIdHeader] as string | undefined

    this.logContext.run({ requestId, tenantId }, () => next())
  }
}
```

**Acceptance criteria:**

- [ ] Middleware reads `x-request-id` if present, generates a UUID if absent
- [ ] Always sets `x-request-id` on the response
- [ ] Starts `logContext.run` before calling `next()`
- [ ] Logs emitted in the downstream handler carry `requestId`
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/middlewares/request-id.middleware.spec.ts
```

**Dependencies:** §3.1, §2.4.

**Risks/Notes:**

- ⚠️ NestJS Middleware runs **before** Guards/Interceptors — perfect for starting the context scope
- ⚠️ Express-only for now. A Fastify adapter may come in v0.2

### 3.6 Update `src/server/index.ts`

**Modification — add exports:**

```typescript
export { LogContextService } from './services/log-context.service'
export { RequestIdMiddleware } from './middlewares/request-id.middleware'
```

### 3.7 Phase 2 tests

**Files to create:**

```
src/server/services/log-context.service.spec.ts
src/server/utils/otel-detector.spec.ts
src/server/mixins/trace-context.mixin.spec.ts
src/server/middlewares/request-id.middleware.spec.ts
```

**Critical cases:**

#### `log-context.service.spec.ts`

```typescript
describe('LogContextService', () => {
  let service: LogContextService

  beforeEach(() => {
    service = new LogContextService()
  })

  it('should propagate context to sync callbacks', () => {
    service.run({ requestId: 'r_1' }, () => {
      expect(service.getStore()).toEqual({ requestId: 'r_1' })
    })
  })

  it('should propagate context across await boundaries', async () => {
    await service.run({ requestId: 'r_1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(service.get('requestId')).toBe('r_1')
    })
  })

  it('should isolate contexts across parallel scopes', async () => {
    const results: string[] = []
    await Promise.all([
      service.run({ requestId: 'A' }, async () => {
        await new Promise((r) => setTimeout(r, 10))
        results.push(service.get('requestId') as string)
      }),
      service.run({ requestId: 'B' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        results.push(service.get('requestId') as string)
      })
    ])
    expect(results.sort()).toEqual(['A', 'B'])
  })

  it('should return undefined outside any scope', () => {
    expect(service.getStore()).toBeUndefined()
    expect(service.get('foo')).toBeUndefined()
  })

  it('should throw when set() is called outside scope', () => {
    expect(() => service.set('foo', 'bar')).toThrow(/outside run/i)
  })

  it('should allow set() inside scope', () => {
    service.run({ requestId: 'r_1' }, () => {
      service.set('userId', 'u_1')
      expect(service.get('userId')).toBe('u_1')
    })
  })
})
```

#### `trace-context.mixin.spec.ts`

```typescript
describe('createTraceContextMixin', () => {
  let logContext: LogContextService
  // Pino 10 mixin contract: (mergeObject, level, logger?) => object
  // Tests MUST pass all 3 args (logger argument optional in our wrapper but
  // accepted by the signature). Level 30 = info.
  const fakeLogger = {} as never

  beforeEach(() => {
    logContext = new LogContextService()
  })

  it('should return empty object when in the context and in the OTel', () => {
    const mixin = createTraceContextMixin(logContext, {
      traceIdField: 'traceId',
      spanIdField: 'spanId',
      traceFlagsField: 'traceFlags',
      shouldAutoInjectTraceContext: false
    })
    expect(mixin({}, 30, fakeLogger)).toEqual({})
  })

  it('should merge LogContext store', () => {
    const mixin = createTraceContextMixin(logContext, {
      traceIdField: 'traceId',
      spanIdField: 'spanId',
      traceFlagsField: 'traceFlags',
      shouldAutoInjectTraceContext: false
    })
    logContext.run({ requestId: 'r_1', tenantId: 't_1' }, () => {
      expect(mixin({}, 30, fakeLogger)).toMatchObject({ requestId: 'r_1', tenantId: 't_1' })
    })
  })

  it('should inject traceId/spanId when OTel span is active and valid', () => {
    const fakeTraceApi: OtelTraceApi = {
      getActiveSpan: () => ({
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1
        })
      })
    }
    // Inject via a stub of detectOtelTraceApi (use jest.mock or DI override).
    // Then assert: mixin({}, 30, fakeLogger) returns { traceId, spanId, traceFlags: '01' }
  })

  it('should skip injection when traceId is all zeros', () => {
    // Span with no-op trace
    // mixin({}, 30, fakeLogger) returns {} (no trace fields)
  })
})
```

**Acceptance criteria:**

- [ ] 100% coverage on `log-context.service.ts`, `otel-detector.ts`, `trace-context.mixin.ts`, `request-id.middleware.ts`
- [ ] Global coverage **100%** (gate `jest.coverage.config.ts`)
- [ ] Mutation score ≥ 99% on the phase's critical paths (run `pnpm mutation --files src/server/services/log-context.service.ts` optionally)

**Validation commands:**

```bash
pnpm test:cov
pnpm test src/server/services/log-context.service.spec.ts
pnpm test src/server/mixins/trace-context.mixin.spec.ts
```

**Dependencies:** §3.1 through §3.6.

### 3.8 Phase 2 validation

**Final commands:**

```bash
pnpm typecheck
pnpm lint
pnpm test:cov
pnpm build
```

**Extended smoke test:**

```javascript
// /tmp/smoke-test-phase2.mjs
import { NestFactory } from '@nestjs/core'
import { Module, Controller, Get } from '@nestjs/common'
import { BymaxLoggerModule, PinoLoggerService, LogContextService, RequestIdMiddleware } from './dist/server/index.mjs'

@Controller()
class TestController {
  constructor(private logger: PinoLoggerService) {}
  @Get() handle() {
    this.logger.info('TEST_HIT', 'Endpoint hit')
    return 'ok'
  }
}

@Module({
  imports: [BymaxLoggerModule.forRoot({ service: { name: 'smoke', version: '0.0.0' } })],
  controllers: [TestController],
})
class TestModule {}

const app = await NestFactory.create(TestModule, { logger: false })
app.use(/* manually attach RequestIdMiddleware */)
await app.listen(3001)
// curl -H "x-request-id: r_test" -H "x-tenant-id: t_test" http://localhost:3001/
// Expected log line includes: requestId: r_test, tenantId: t_test
```

**Done criteria:**

- [ ] Smoke test shows `requestId` propagated in the handler log
- [ ] Coverage gates met
- [ ] Commits made with Conventional Commits

---

## 4. Phase 3 — HTTP Interceptor + Filter + Decorators

> **Phase goal:** Automatic logging of HTTP requests (start/success/redirect/4xx/5xx) with normalized URLs, HTTP exception capture, and the ergonomic `@InjectLogger`, `@LogContext`, `@LogPerformance` decorators.
>
> **Complexity:** MEDIUM.
>
> **Critical paths (mutation 100% required):** `src/server/interceptors/http-logging.interceptor.ts`, `src/server/utils/normalize-url.util.ts`, `src/server/filters/http-exception.filter.ts`. Coverage for **every** file in the phase: **100%**.

### 4.1 `normalizeUrl` utility

**Goal:** Pure function that normalizes request URLs — replaces IDs with `/:id` placeholders to avoid an explosion of distinct log keys.

**Files to create:**

```
src/server/utils/normalize-url.util.ts
```

**Skeleton:**

```typescript
const UUID_REGEX = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ULID_REGEX = /\/[0-9A-HJKMNP-TV-Z]{26}/g // Crockford base32, 26 chars
const NANOID_REGEX = /\/[A-Za-z0-9_-]{21}/g // nanoid default size
const NUMERIC_ID_REGEX = /\/\d+/g

/**
 * Normalizes a request URL by replacing identifiers with `/:id`.
 *
 * Handles:
 *   - UUIDs (8-4-4-4-12 hex)
 *   - ULIDs (26 chars Crockford base32)
 *   - nanoids (21 chars URL-safe)
 *   - Numeric IDs
 *
 * Strips query string before normalization.
 *
 * @example
 *   normalizeUrl('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736')
 *   // → '/users/:id'
 *   normalizeUrl('/users/123?fields=name')
 *   // → '/users/:id'
 */
export function normalizeUrl(url: string): string {
  const path = url.split('?')[0] ?? ''
  return path
    .replace(UUID_REGEX, '/:id')
    .replace(ULID_REGEX, '/:id')
    .replace(NANOID_REGEX, '/:id')
    .replace(NUMERIC_ID_REGEX, '/:id')
}
```

**Acceptance criteria:**

- [ ] UUIDs recognized and replaced
- [ ] ULIDs recognized and replaced
- [ ] nanoids recognized and replaced
- [ ] Numeric IDs recognized
- [ ] Query string removed
- [ ] 100% coverage
- [ ] Mutation score ≥ 99% (high blast radius — a false positive corrupts log queries)

**Validation commands:**

```bash
pnpm test src/server/utils/normalize-url.util.spec.ts
```

### 4.2 `HttpLoggingInterceptor`

**Goal:** Global interceptor that logs the full HTTP request lifecycle.

**Files to create:**

```
src/server/interceptors/http-logging.interceptor.ts
```

**Skeleton:**

```typescript
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor
} from '@nestjs/common'
import { Observable, catchError, tap, throwError } from 'rxjs'
import type { Request, Response } from 'express'
import { PinoLoggerService } from '../services/pino-logger.service'
import { normalizeUrl } from '../utils/normalize-url.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLoggerService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp()
    const req = http.getRequest<Request>()
    const res = http.getResponse<Response>()

    const { method, url, ip } = req
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? 'unknown'
    const userId = (req as Request & { user?: { id?: string } }).user?.id
    const normalizedUrl = normalizeUrl(url)
    const start = Date.now()

    this.logger.info(RESERVED_LOG_KEYS.HTTP_REQUEST_START, `${method} ${normalizedUrl}`, userId, {
      method,
      url: normalizedUrl,
      fullUrl: url,
      ip,
      userAgent
    })

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start
        const statusCode = res.statusCode
        if (statusCode >= 200 && statusCode < 300) {
          this.logger.info(
            RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS,
            `${method} ${normalizedUrl} → ${statusCode} (${duration}ms)`,
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        } else if (statusCode >= 300 && statusCode < 400) {
          this.logger.info(
            RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT,
            `${method} ${normalizedUrl} → ${statusCode}`,
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        }
      }),
      catchError((err: unknown) => {
        const duration = Date.now() - start
        const statusCode =
          err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

        if (statusCode >= 500) {
          this.logger.errorStructured(
            RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR,
            err instanceof Error ? err : new Error(String(err)),
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        } else {
          this.logger.warnStructured(
            RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
            `${method} ${normalizedUrl} → ${statusCode}`,
            userId,
            {
              method,
              url: normalizedUrl,
              statusCode,
              duration,
              errorMessage: (err as { message?: string }).message
            }
          )
        }
        return throwError(() => err)
      })
    )
  }
}
```

**Acceptance criteria:**

- [ ] A 200 request emits `HTTP_REQUEST_START` + `HTTP_REQUEST_SUCCESS`
- [ ] A 3xx request emits `HTTP_REQUEST_START` + `HTTP_REQUEST_REDIRECT`
- [ ] A 4xx request emits `HTTP_REQUEST_START` + `HTTP_REQUEST_CLIENT_ERROR` (warn)
- [ ] A 5xx request emits `HTTP_REQUEST_START` + `HTTP_REQUEST_SERVER_ERROR` (error with stack)
- [ ] Exception propagated after the log (not swallowed)
- [ ] Normalized URL used in the logs
- [ ] `userId` extracted from `req.user.id` when present
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/interceptors/http-logging.interceptor.spec.ts
```

**Dependencies:** §2.7 (`PinoLoggerService`), §4.1.

### 4.3 `HttpExceptionFilter`

**Goal:** Catches exceptions that escape the interceptors. Logs with a level based on the status code.

**Files to create:**

```
src/server/filters/http-exception.filter.ts
```

**Skeleton:**

```typescript
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import type { Request, Response } from 'express'
import { PinoLoggerService } from '../services/pino-logger.service'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<Request>()

    const isHttp = exception instanceof HttpException
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
    const body = isHttp
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' }

    const userId = (req as Request & { user?: { id?: string } }).user?.id
    const metadata = { method: req.method, url: req.url, status }

    if (status >= 500) {
      this.logger.errorStructured(
        RESERVED_LOG_KEYS.HTTP_EXCEPTION_UNHANDLED,
        exception instanceof Error ? exception : new Error(String(exception)),
        userId,
        metadata
      )
    } else {
      this.logger.warnStructured(
        RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED,
        (exception as { message?: string }).message ?? 'HTTP exception',
        userId,
        metadata
      )
    }

    res.status(status).json(body)
  }
}
```

**Acceptance criteria:**

- [ ] A 5xx escapes to the filter → `HTTP_EXCEPTION_UNHANDLED` (error) emitted
- [ ] A 4xx escapes to the filter → `HTTP_EXCEPTION_HANDLED` (warn) emitted
- [ ] Final response is JSON with the correct status
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/filters/http-exception.filter.spec.ts
```

**Dependencies:** §2.7.

### 4.4 Decorators (`@InjectLogger`, `@LogContext`, `@LogPerformance`)

**Goal:** Ergonomic decorators.

**Files to create:**

```
src/server/decorators/
├── inject-logger.decorator.ts
├── log-context.decorator.ts
└── log-performance.decorator.ts
```

**Skeleton — `inject-logger.decorator.ts`:**

````typescript
import { Inject } from '@nestjs/common'
import { PinoLoggerService } from '../services/pino-logger.service'

/**
 * Inject PinoLoggerService with an optional context. Equivalent to:
 *
 * ```ts
 * constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {
 *   this.logger.setContext('UsersService')
 * }
 * ```
 *
 * but without the manual setContext call.
 *
 * Implementation note: the parameter decorator wraps `@Inject(PinoLoggerService)`
 * and uses metadata to schedule `setContext()` after instantiation. We use a
 * `Provider`-level wrap rather than instance-level metadata because parameter
 * decorators cannot access the host class at construction time without
 * extra wiring (NestJS's `ModuleRef` post-init pattern).
 */
export function InjectLogger(context?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    Inject(PinoLoggerService)(target, propertyKey, parameterIndex)
    if (context) {
      Reflect.defineMetadata(
        'bymax_logger:context',
        context,
        target,
        `${String(propertyKey)}:${parameterIndex}`
      )
    }
  }
}
````

> **Note:** The end version uses a `LoggerContextInterceptor` (introduced in Phase 4) that reads the metadata and calls `setContext()`. For Phase 3 the decorator stays functional with the basic side (injection); the automatic `setContext()` is closed in Phase 4. **Documented interim workaround:** the consumer can call `this.logger.setContext('MyService')` in the constructor.

**Skeleton — `log-context.decorator.ts`:**

```typescript
import { SetMetadata } from '@nestjs/common'

export const LOG_CONTEXT_METADATA_KEY = 'bymax_logger:log_context'

/**
 * Class-level decorator that sets the log context for all PinoLoggerService
 * instances injected via @InjectLogger() within the class.
 *
 * @example
 *   @LogContext('PaymentsService')
 *   @Injectable()
 *   export class PaymentsService {
 *     constructor(@InjectLogger() private readonly logger: PinoLoggerService) {}
 *   }
 */
export const LogContext = (name: string) => SetMetadata(LOG_CONTEXT_METADATA_KEY, name)
```

**Skeleton — `log-performance.decorator.ts`:**

```typescript
import { PinoLoggerService } from '../services/pino-logger.service'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

/**
 * Method decorator that logs execution duration. If above threshold, logs as warn.
 *
 * @example
 *   class ReportService {
 *     constructor(@InjectLogger() private logger: PinoLoggerService) {}
 *
 *     @LogPerformance(500)  // warn if > 500ms
 *     async generateReport() { ... }
 *   }
 */
export function LogPerformance(thresholdMs = 1000): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown
    descriptor.value = async function (this: { logger?: PinoLoggerService }, ...args: unknown[]) {
      const start = Date.now()
      try {
        return await original.apply(this, args)
      } finally {
        const duration = Date.now() - start
        const method = `${target.constructor.name}.${String(propertyKey)}`
        if (this.logger) {
          if (duration > thresholdMs) {
            this.logger.warnStructured(
              RESERVED_LOG_KEYS.METHOD_SLOW_EXECUTION,
              `${method} took ${duration}ms (threshold ${thresholdMs}ms)`,
              undefined,
              { method, duration, thresholdMs }
            )
          } else {
            this.logger.info(RESERVED_LOG_KEYS.METHOD_EXECUTION, `${method} completed`, undefined, {
              method,
              duration
            })
          }
        }
      }
    }
    return descriptor
  }
}
```

**Acceptance criteria:**

- [ ] `@InjectLogger()` injects `PinoLoggerService` correctly
- [ ] `@LogPerformance(50)` logs `METHOD_SLOW_EXECUTION` when the method takes > 50ms
- [ ] `@LogPerformance(50)` logs `METHOD_EXECUTION` when the method takes < 50ms
- [ ] `@LogPerformance` propagates the return value unchanged
- [ ] `@LogPerformance` propagates exceptions without swallowing
- [ ] `@LogContext(name)` sets metadata on the class
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/decorators/
```

**Dependencies:** §2.7.

### 4.5 Interceptor + Filter integration in the module

**Goal:** When `http.isEnabled: true`, register the interceptor and filter as global via `APP_INTERCEPTOR` and `APP_FILTER`.

**Files to modify:**

```
src/server/logger.module.ts
```

**Modification:**

```typescript
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core'
import { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
import { HttpExceptionFilter } from './filters/http-exception.filter'

// Inside the forRoot method:
if (resolved.http.isEnabled) {
  providers.push({ provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor })
  if (resolved.http.shouldCaptureExceptions) {
    providers.push({ provide: APP_FILTER, useClass: HttpExceptionFilter })
  }
}
```

**Middleware** is registered **outside forRoot** because NestJS requires `configure(consumer)` in `Module` — the lib can expose a utility class:

```typescript
// src/server/middlewares/apply-request-id-middleware.ts
import { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { RequestIdMiddleware } from './request-id.middleware'

/**
 * Helper for consumer apps:
 *
 * @example
 *   import { applyRequestIdMiddleware } from '@bymax-one/nest-logger'
 *
 *   @Module({ imports: [...] })
 *   export class AppModule implements NestModule {
 *     configure(consumer: MiddlewareConsumer) {
 *       applyRequestIdMiddleware(consumer)
 *     }
 *   }
 */
export function applyRequestIdMiddleware(consumer: MiddlewareConsumer, routes: string = '*'): void {
  consumer.apply(RequestIdMiddleware).forRoutes(routes)
}
```

**Acceptance criteria:**

- [ ] `http.isEnabled: false` (default) does **not** register the interceptor or filter
- [ ] `http.isEnabled: true` registers `HttpLoggingInterceptor` as APP_INTERCEPTOR
- [ ] `http.shouldCaptureExceptions: false` (even with `isEnabled: true`) does not register the filter
- [ ] `applyRequestIdMiddleware` helps the consumer configure the middleware

### 4.6 Update `src/server/index.ts`

```typescript
export { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
export { HttpExceptionFilter } from './filters/http-exception.filter'
export { InjectLogger } from './decorators/inject-logger.decorator'
export { LogContext, LOG_CONTEXT_METADATA_KEY } from './decorators/log-context.decorator'
export { LogPerformance } from './decorators/log-performance.decorator'
export { applyRequestIdMiddleware } from './middlewares/apply-request-id-middleware'
```

### 4.7 Phase 3 tests

**Files to create:**

```
src/server/utils/normalize-url.util.spec.ts
src/server/interceptors/http-logging.interceptor.spec.ts
src/server/filters/http-exception.filter.spec.ts
src/server/decorators/inject-logger.decorator.spec.ts
src/server/decorators/log-performance.decorator.spec.ts
```

**Critical cases:**

- `normalize-url.util.spec.ts`: 8-10 cases covering UUID v4, UUID v1, ULID, nanoid, numeric, mixed, query strings, edge cases (empty URL, trailing slash)
- `http-logging.interceptor.spec.ts`: use `Test.createTestingModule` + `supertest` to issue a real request and capture logs via a spy on `PinoLoggerService`
- `http-exception.filter.spec.ts`: simulate `ArgumentsHost` mock, verify logs and response shape
- `log-performance.decorator.spec.ts`: tests with `await new Promise((r) => setTimeout(r, X))` to force the threshold

**Acceptance criteria:**

- [ ] 100% coverage in `normalize-url.util.ts`
- [ ] 100% coverage in interceptor, filter, decorators (per-file gate via `jest.config.ts`)
- [ ] Global coverage **100%** (gate `jest.coverage.config.ts`)

### 4.8 Phase 3 validation

```bash
pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build
```

**Smoke test:**

```typescript
@Controller()
class TestController {
  constructor(@InjectLogger(TestController.name) private logger: PinoLoggerService) {}

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    this.logger.info('USER_FETCH', `Fetching user ${id}`, id)
    if (id === '5xx') throw new Error('boom')
    return { id }
  }
}
```

Expected:

- GET `/users/abc-uuid-xyz` → 2 logs: `HTTP_REQUEST_START` + `HTTP_REQUEST_SUCCESS`, both with `url: /users/:id`
- GET `/users/5xx` → 4 logs: `HTTP_REQUEST_START` + `USER_FETCH` + `HTTP_EXCEPTION_UNHANDLED` (filter) + `HTTP_REQUEST_SERVER_ERROR` (interceptor)

**Done criteria:**

- [ ] Smoke test passes
- [ ] Coverage gate ok
- [ ] PR `phase-3` with `/bymax-quality:code-review` applied

---

## 5. Phase 4 — Pretty Destination + Custom Destinations + Testing Suite

> **Phase goal:** Add `PrettyDevDestination`, destination lifecycle via `DestinationRegistry`, truncation of large entries, `forRootAsync()`, an E2E test suite against a fixture app, and a mutation testing baseline.
>
> **Complexity:** HIGH — Pino multi-stream + destination lifecycle + e2e suite are the areas most prone to subtle bugs (initialization order, shutdown race conditions, mock isolation between specs).

### 5.1 `PrettyDevDestination`

**Goal:** Destination that uses `pino-pretty` for readable dev output. Auto-registered when `NODE_ENV !== 'production'` or `pretty: true`.

**Files to create:**

```
src/server/destinations/pretty-dev.destination.ts
```

**Skeleton:**

```typescript
import { Transform } from 'node:stream'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Development-only destination that pipes through pino-pretty for human-readable output.
 *
 * Requires `pino-pretty` as an optional peer dependency.
 * If not installed and pretty is enabled, the library logs a warning and falls back to
 * DefaultStdoutDestination.
 */
export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  private stream!: Transform

  async onInit(): Promise<void> {
    let pretty: typeof import('pino-pretty').default
    try {
      pretty = (await import('pino-pretty')).default
    } catch {
      throw new Error(
        '[PrettyDevDestination] pino-pretty is not installed. Install it as a peer dep or disable `isPretty` option.'
      )
    }
    this.stream = pretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
      singleLine: false
    })
    this.stream.pipe(process.stdout)
  }

  write(payload: string): void {
    this.stream.write(payload)
  }

  async onShutdown(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve))
  }
}
```

**Acceptance criteria:**

- [ ] In an environment with `pino-pretty` installed, `onInit()` resolves without error
- [ ] In an environment without `pino-pretty`, `onInit()` throws Error with a clear message
- [ ] `write()` writes to the pretty stream (verifiable via spy)
- [ ] `onShutdown()` awaits stream end
- [ ] 100% coverage

### 5.2 `DestinationRegistry`

**Goal:** Internal service that manages the lifecycle of every registered destination.

**Files to create:**

```
src/server/services/destination-registry.service.ts
```

**Skeleton:**

```typescript
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { LOGGER_DESTINATIONS_TOKEN } from '../constants/injection-tokens.constants'
import { PinoLoggerService } from './pino-logger.service'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

@Injectable()
export class DestinationRegistry implements OnModuleInit, OnApplicationShutdown {
  private active: ILogDestination[] = []

  constructor(
    @Inject(LOGGER_DESTINATIONS_TOKEN) private readonly registered: readonly ILogDestination[],
    private readonly logger: PinoLoggerService
  ) {}

  async onModuleInit(): Promise<void> {
    for (const dest of this.registered) {
      try {
        await dest.onInit?.()
        this.active.push(dest)
      } catch (err) {
        this.logger.errorStructured(
          RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          { destination: dest.name }
        )
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Reverse order — destinations registered first close last
    for (const dest of [...this.active].reverse()) {
      try {
        await dest.onShutdown?.()
      } catch (err) {
        // Best-effort during shutdown; log via console fallback
        console.error(`[DestinationRegistry] Shutdown failure for ${dest.name}:`, err)
      }
    }
  }

  /**
   * Returns active destinations — used by `pino-factory` to wire multi-stream.
   */
  getActive(): readonly ILogDestination[] {
    return this.active
  }
}
```

**Multi-stream wiring in pino-factory:**

`buildPinoInstance` needs to receive the `DestinationRegistry` (or its destinations) and configure `pino.multistream`. This requires destinations to be exposed as `Writable` streams. The lib introduces a helper:

```typescript
// src/server/utils/destination-to-stream.ts
import { Writable } from 'node:stream'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { writeStderrSafely } from '../utils/safe-stdio.util'

export function destinationToStream(dest: ILogDestination): Writable {
  return new Writable({
    write(chunk, _enc, callback) {
      // A failure is CONTAINED: report it and complete the write as successful.
      // `callback(err)` makes the Writable emit 'error', which with no listener
      // terminates the host — the opposite of the fail-soft contract.
      const reportAndContinue = (err: unknown): void => {
        // `writeStderrSafely`, not `process.stderr.write`: a closed pipe reports
        // EPIPE asynchronously and would kill the host from inside the containment.
        writeStderrSafely(`LOGGER_DESTINATION_WRITE_FAILED ${dest.name}: ${String(err)}\n`)
        callback()
      }
      try {
        const r = dest.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
        // Branch on `undefined`: `instanceof Promise` is realm-local and misses a
        // cross-realm promise or a plain thenable, losing the entry. A rejection is
        // reported and then completed WITHOUT an error — `callback(err)` makes the
        // stream emit 'error' and takes the host down. See CHANGELOG 1.2.9.
        if (r === undefined) callback()
        else Promise.resolve(r).then(() => callback(), reportAndContinue)
      } catch (err) {
        reportAndContinue(err)
      }
    }
  })
}
```

And `pino-factory` switches to using `pino.multistream`:

```typescript
import pino from 'pino'
import { destinationToStream } from './utils/destination-to-stream'

// inside buildPinoInstance:
const streams = destinations.map((d) => ({
  level: d.minLevel ?? options.level,
  stream: destinationToStream(d)
}))
const pinoInstance = pino(pinoOpts, pino.multistream(streams))
```

**Acceptance criteria:**

- [ ] `onModuleInit` calls `onInit()` on every destination
- [ ] A destination that throws in `onInit()` is skipped (does not block bootstrap)
- [ ] Meta log `LOGGER_DESTINATION_INIT_FAILED` is emitted
- [ ] `onApplicationShutdown` calls `onShutdown()` in reverse order
- [ ] Multi-stream wiring works (logs reach every active destination)
- [ ] 100% coverage

### 5.3 Large entry truncation

**Goal:** Protect against an explosion of giant log entries (e.g., a full Stripe webhook payload).

**Implementation:** Custom Pino serializer that checks size and truncates.

**Files to create:**

```
src/server/utils/truncate-large-entries.ts
```

**Skeleton:**

```typescript
const TRUNCATION_MARKER = '_truncated' as const

/**
 * Wraps a serializer to enforce a maximum size in bytes.
 * If the serialized JSON exceeds `maxBytes`, replaces the value with a marker.
 */
export function createSizeBoundedSerializer(
  baseSerializer: (input: unknown) => unknown,
  maxBytes: number
) {
  return (input: unknown): unknown => {
    const serialized = baseSerializer(input)
    const json = JSON.stringify(serialized)
    if (Buffer.byteLength(json, 'utf-8') > maxBytes) {
      return {
        [TRUNCATION_MARKER]: true,
        _originalSize: Buffer.byteLength(json, 'utf-8'),
        _preview: json.substring(0, 200)
      }
    }
    return serialized
  }
}
```

**Acceptance criteria:**

- [ ] Entries < `maxBytes` pass through intact
- [ ] Entries > `maxBytes` become `{ _truncated: true, _originalSize, _preview }`
- [ ] 100% coverage

### 5.4 `forRootAsync()` — validation and scenarios

**Goal:** `forRootAsync()` already exists since Phase 1 (auto-generated by `ConfigurableModuleBuilder` — see §2.8). This sub-step **validates** that both paths (sync + async) work correctly with real-world scenarios and adds providers that need async-lazy (e.g., Pino multi-stream depending on resolved destinations).

**Files to modify:**

```
src/server/logger.module.ts          # add conditional HTTP providers in the async path
test/e2e/logger-async-config.e2e-spec.ts   # E2E with ConfigService
```

**Scenarios to cover:**

1. **useFactory with `ConfigModule`**: read `LOG_LEVEL` from env, build options
2. **async useFactory** (returns Promise): scenario where options come from Vault/Secret Manager
3. **useClass**: `LoggerOptionsFactory` class implementing `createLoggerOptions()`
4. **useExisting**: reuse a provider already registered in another module
5. **isGlobal: false on the async path**: validate that `setExtras` honors the flag

**Acceptance criteria:**

- [ ] `forRootAsync()` accepts `useFactory + inject`, `useClass`, `useExisting` (3 canonical NestJS patterns)
- [ ] Bootstrap log emitted **after** options resolve (not before)
- [ ] `useFactory` can return `Promise<BymaxLoggerModuleOptions>`
- [ ] E2E spec exercises ConfigService as a factory dep
- [ ] `isGlobal: false` on the async path works (does not pollute other modules — `setExtras` flag honored)
- [ ] 100% coverage on the async path of `logger.module.ts`

### 5.4a `@InjectLogger` context wiring (custom provider factory)

**Goal:** Close the loop on the §4.4 `@InjectLogger('Ctx')` decorator: an injected logger must automatically emit logs with `context: 'Ctx'` without the consumer calling `setContext()` manually.

**Preferred mechanism (per latest spec decision):** **child-logger via a custom provider factory** — NOT request-scoped DI. Request scope would force the entire dependency tree below the consumer into transient/request scope and break Nest's singleton assumptions. A child logger (`pino.child({ context })`) is cheap, sync, and inherits redact/level/serializers from the parent.

**Files to create:**

```
src/server/services/inject-logger.provider.ts   # custom provider factory that reads @InjectLogger metadata via reflection
```

**Skeleton:**

```typescript
import type { FactoryProvider } from '@nestjs/common'
import { PinoLoggerService } from './pino-logger.service'
import { LOGGER_PINO_INSTANCE_TOKEN } from '../constants/injection-tokens.constants'
import type { Logger as PinoLogger } from 'pino'

/**
 * Build a custom factory provider that resolves to a `PinoLoggerService`
 * pre-bound to the `context` argument of `@InjectLogger('UsersController')`.
 *
 * Implementation outline:
 *   1. Read the `'bymax_logger:context'` metadata stored by the @InjectLogger
 *      decorator on the target parameter (set in §4.4).
 *   2. Call `pino.child({ context })` to fork a child logger that carries the
 *      context on every log emission, without mutating shared state.
 *   3. Wrap the child in a new `PinoLoggerService` instance.
 *
 * Why child-logger and not request scope?
 *   - Singleton-safe: no Nest scope cascade.
 *   - Zero-cost per request (no allocation).
 *   - Composes with ALS context (the mixin still reads requestId/userId from ALS).
 */
export function createInjectLoggerProvider(context: string): FactoryProvider {
  return {
    provide: `BYMAX_LOGGER_CTX:${context}`,
    inject: [LOGGER_PINO_INSTANCE_TOKEN],
    useFactory: (pino: PinoLogger) => {
      const child = pino.child({ context })
      // PinoLoggerService accepts a Pino instance via DI — pass the child directly.
      return new PinoLoggerService(child)
    }
  }
}
```

**Acceptance criteria:**

- [ ] `@InjectLogger('UsersController')` injects a `PinoLoggerService` whose every emitted log carries `context: 'UsersController'`
- [ ] Verified via fixture-app integration test (NOT mock): boot a NestJS app with a controller using `@InjectLogger('UsersController')`, hit an endpoint, capture stdout, assert the log JSON contains `"context":"UsersController"`
- [ ] No request scope introduced (verify by injecting the same logger into 2 parallel requests and confirming the same instance is reused)
- [ ] 100% coverage on `inject-logger.provider.ts`
- [ ] Mutation score ≥ 99% on the factory (critical path — wiring bug breaks every consumer)

**Validation commands:**

```bash
pnpm test src/server/services/inject-logger.provider.spec.ts
pnpm test:e2e test/e2e/inject-logger.e2e-spec.ts
```

**Dependencies:** §4.4 (decorator + metadata), §2.7 (`PinoLoggerService`), §2.8 (`LOGGER_PINO_INSTANCE_TOKEN`).

**Risks/Notes:**

- ⚠️ `pino.child()` copies parent bindings shallowly; mutating the parent's `redact` paths after children are forked does NOT propagate. Document this.
- ⚠️ If the consumer omits `@InjectLogger('Ctx')` and uses `@InjectLogger()` alone, fall back to the raw `PinoLoggerService` provider (no child fork).

### 5.4b `BymaxLoggerModule.useNestLogger(app)` helper

**Goal:** Static helper that replaces Nest's default internal logger with our `PinoLoggerService` in one call from `main.ts`.

**Files to modify:**

```
src/server/logger.module.ts   # add the static helper
README.md                     # main.ts wiring example (Phase 5 README sub-step)
```

**Skeleton:**

```typescript
import type { INestApplication } from '@nestjs/common'
import { PinoLoggerService } from './services/pino-logger.service'

// Inside BymaxLoggerModule class body:
/**
 * Replace Nest's internal logger with our `PinoLoggerService`.
 *
 * The consumer MUST call this AFTER `NestFactory.create(AppModule, { bufferLogs: true })`
 * and BEFORE `app.listen(...)`. The `bufferLogs: true` flag tells Nest to hold
 * its internal logs until the replacement is in place, ensuring even
 * bootstrap-time logs flow through structured JSON.
 *
 * @example
 *   const app = await NestFactory.create(AppModule, { bufferLogs: true })
 *   BymaxLoggerModule.useNestLogger(app)
 *   await app.listen(3000)
 */
static useNestLogger(app: INestApplication): void {
  const logger = app.get(PinoLoggerService)
  app.useLogger(logger)
  app.flushLogs() // flush the buffer captured by bufferLogs: true
}
```

**Acceptance criteria:**

- [ ] `BymaxLoggerModule.useNestLogger(app)` is exposed as a static method on the public class
- [ ] In a fixture-app calling `useNestLogger(app)`, a `Logger.log('msg')` call (Nest's built-in `Logger`) produces structured JSON via our service (verifiable via stdout spy assertion containing `"logKey"` or our schema markers)
- [ ] README §1 (Quick Start) shows the canonical `main.ts` wiring with `bufferLogs: true` + `useNestLogger(app)` + `app.listen(...)`
- [ ] 100% coverage on the helper
- [ ] Integration test in `test/e2e/use-nest-logger.e2e-spec.ts` validates the full bootstrap-to-handler log flow

**Validation commands:**

```bash
pnpm test src/server/logger.module.spec.ts
pnpm test:e2e test/e2e/use-nest-logger.e2e-spec.ts
```

**Dependencies:** §2.8 (module + service registered), §2.7 (`PinoLoggerService`).

**Risks/Notes:**

- ⚠️ Forgetting `bufferLogs: true` is the most common bootstrap-time bug; the README must call it out in bold.
- ⚠️ The helper depends on `app.get(PinoLoggerService)` succeeding — which requires `BymaxLoggerModule.forRoot(...)` to be imported in `AppModule`. Throw with a clear error message if the service is not found.

### 5.4c `sanitize-error.util` (extracted from §4.3)

**Goal:** Dedicated, well-tested error sanitizer used by `HttpExceptionFilter`, `errorStructured()`, and the destination registry's meta-logs. Spec §3.1 declares `src/server/utils/sanitize-error.util.ts` as a first-class artifact — the plan previously hid the work inside §4.3. This sub-step promotes it to its own gate.

**Why this lives in Phase 3 conceptually but is enforced here:** the file is consumed by §4.3 (filter) but its tests must achieve 100% coverage before §4.3 closes. Treat this as a Phase 3 sub-step in `development_tasks.md`, executed BEFORE §4.3.

**Files to create:**

```
src/server/utils/sanitize-error.util.ts
src/server/utils/sanitize-error.util.spec.ts
```

**Skeleton:**

```typescript
/**
 * Normalize any thrown value into a JSON-safe shape:
 *   - `Error`, `TypeError`, `RangeError` (and other native subclasses) → { name, message, stack, cause? }
 *   - `AggregateError` → { name, message, errors: SanitizedError[] }
 *   - circular refs → marker `[Circular]`
 *   - `cause` chain → walked recursively up to depth 5
 *   - non-Error values (`string`, `number`, plain object) → `{ name: 'Unknown', message: String(value) }`
 *
 * Returns a plain object; pino's `err` serializer can consume it directly.
 */
export function sanitizeError(
  input: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): SanitizedError {
  // Implementation walks the cause chain, guards against circular refs via `seen`,
  // and caps depth at 5 to avoid pathological inputs.
}

export interface SanitizedError {
  name: string
  message: string
  stack?: string
  cause?: SanitizedError
  errors?: SanitizedError[]
}
```

**Acceptance criteria:**

- [ ] Handles `new Error('boom')` → `{ name: 'Error', message: 'boom', stack: <string> }`
- [ ] Handles `new TypeError('bad arg')` → `{ name: 'TypeError', ... }`
- [ ] Handles `new RangeError('out of bounds')` → `{ name: 'RangeError', ... }`
- [ ] Handles `new AggregateError([new Error('a'), new Error('b')])` → `{ errors: [...] }` with each sanitized
- [ ] Handles `new Error('outer', { cause: new Error('inner') })` → `{ cause: { ... } }` (recursive sanitize)
- [ ] Handles circular references: an object with a property pointing back to itself returns `[Circular]` marker, no infinite recursion
- [ ] Handles non-Error inputs: `sanitizeError('plain string')` returns `{ name: 'Unknown', message: 'plain string' }`
- [ ] Handles `null` / `undefined` without throwing
- [ ] 100% coverage gate (critical path — used by every error log)
- [ ] Mutation score ≥ 99%

**Validation commands:**

```bash
pnpm test src/server/utils/sanitize-error.util.spec.ts
pnpm test:cov
```

**Dependencies:** none (pure utility). Consumed by §4.3 (`HttpExceptionFilter`), §2.7 (`errorStructured()`), §5.2 (`DestinationRegistry` meta-logs).

**Risks/Notes:**

- ⚠️ Pino has a built-in `pino.stdSerializers.err`. We do NOT replace it — `sanitizeError` is for OUR call sites (filter, errorStructured) that need the cause chain + circular-ref safety. The default pino serializer is still wired for the `err` field convention.
- ⚠️ Order this sub-step BEFORE §4.3 in `development_tasks.md` so the filter has its dep ready.

### 5.4d Performance benchmark (regression budget)

**Goal:** Validate the spec's "5-7× faster than Winston" claim and lock a regression budget so future PRs cannot silently degrade throughput.

**Files to create:**

```
bench/throughput.bench.ts
bench/README.md   # how to run, how to interpret results
.github/workflows/ci.yml   # add `pnpm bench:ci` step on Phase 4 PRs
```

**Tool choice:** `tinybench` (pinned). Rationale: zero deps beyond Node, deterministic warm-up, JSON output suitable for CI assertion. `mitata` was considered but tinybench is the standard for our Phase 4 PRs — pick one and stick to it.

**Scenarios to benchmark:**

1. **bare Pino 10** — baseline (`pino()` with default options writing to `/dev/null`).
2. **`PinoLoggerService` no destinations + default mixin** — wrapper overhead measurement.
3. **`PinoLoggerService` + full redact (97 paths) + composed mixin (ALS + OTel)** — full prod path.

**Skeleton:**

```typescript
import { Bench } from 'tinybench'
import pino from 'pino'
import { PinoLoggerService } from '../src/server/services/pino-logger.service'
// ... wiring per scenario

const bench = new Bench({ time: 5000, warmupTime: 500 })

bench
  .add('bare pino 10', () => {
    barePino.info({ logKey: 'BENCH', userId: 'u_1' }, 'bench')
  })
  .add('PinoLoggerService default', () => {
    svc.info('BENCH', 'bench', 'u_1')
  })
  .add('PinoLoggerService full redact + composed mixin', () => {
    svcFull.info('BENCH', 'bench', 'u_1', { password: 'secret', token: 'x' })
  })

await bench.run()
console.log(bench.table())

// Regression budget assertions (fail CI on regression):
const baseline = bench.tasks.find((t) => t.name === 'bare pino 10')!.result!.hz
const wrapper = bench.tasks.find((t) => t.name === 'PinoLoggerService default')!.result!.hz
const fullPath = bench.tasks.find(
  (t) => t.name === 'PinoLoggerService full redact + composed mixin'
)!.result!.hz

// 10% wrapper overhead budget (matches spec §10.x performance budget)
if (wrapper < baseline * 0.9) {
  console.error(`Wrapper overhead exceeded 10% — wrapper ${wrapper} vs baseline ${baseline}`)
  process.exit(1)
}
// 5% redact throughput cost vs no-redact
if (fullPath < wrapper * 0.95) {
  console.error(
    `Redact path exceeded 5% throughput cost — fullPath ${fullPath} vs wrapper ${wrapper}`
  )
  process.exit(1)
}
```

**Acceptance criteria:**

- [ ] `bench/throughput.bench.ts` exists and runs to completion under 60s
- [ ] CI job (`bench` step in `ci.yml`) runs on every PR with the `phase-4` label and fails on regression
- [ ] Regression budget enforced:
  - Wrapper (PinoLoggerService default) within **10% allocation overhead** of bare Pino 10
  - Full redact path (97 paths) within **5% throughput cost** of no-redact path
- [ ] `bench/README.md` documents how to run locally (`pnpm bench`) and how the budgets were chosen
- [ ] Output JSON archived as a CI artifact for trend tracking

**Validation commands:**

```bash
pnpm bench                   # local run
pnpm bench:ci                # CI invocation (sets BENCH_CI=true for stricter time budget)
```

**Dependencies:** §5.1 (full destination wiring), §5.2 (multi-stream), §5.3 (truncation — verify it does NOT regress hot path).

**Risks/Notes:**

- ⚠️ Benchmark noise: pin Node version in CI, run on dedicated runner if possible, use `tinybench` warm-up to stabilize.
- ⚠️ The 10% / 5% budgets are deliberately loose for v0.1.0. Tighten in v0.2 once a multi-week trend is available.

### 5.5 E2E tests with fixture app

**Goal:** End-to-end suite that spins up a real NestJS app and validates full-stack behavior.

**Files to create:**

```
test/e2e/
├── fixtures/
│   ├── test-app.module.ts
│   └── test.controller.ts
├── logger-basic.e2e-spec.ts
├── logger-http.e2e-spec.ts
└── logger-async-config.e2e-spec.ts
```

**Skeleton — `logger-http.e2e-spec.ts`:**

```typescript
import { Test } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { BymaxLoggerModule, applyRequestIdMiddleware } from '../../src/server'
import { TestController } from './fixtures/test.controller'

describe('Logger E2E — HTTP', () => {
  let app: INestApplication
  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e', version: '0.0.0' },
          http: { isEnabled: true }
        })
      ],
      controllers: [TestController]
    }).compile()

    app = module.createNestApplication()
    // Apply middleware here
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    stdoutSpy.mockRestore()
  })

  it('should log HTTP_REQUEST_START and HTTP_REQUEST_SUCCESS for a 200 request', async () => {
    stdoutSpy.mockClear()
    await request(app.getHttpServer()).get('/hello').expect(200)
    const logs = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(logs).toContain('"logKey":"HTTP_REQUEST_START"')
    expect(logs).toContain('"logKey":"HTTP_REQUEST_SUCCESS"')
    expect(logs).toContain('"url":"/hello"')
  })

  it('should normalize URLs with UUID', async () => {
    stdoutSpy.mockClear()
    await request(app.getHttpServer())
      .get('/users/4bf92f35-77b3-4da6-a3ce-929d0e0e4736')
      .expect(200)
    const logs = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(logs).toContain('"url":"/users/:id"')
  })

  it('should propagate x-request-id across logs', async () => {
    // ... test middleware
  })

  it('should log HTTP_REQUEST_SERVER_ERROR for 500', async () => {
    stdoutSpy.mockClear()
    await request(app.getHttpServer()).get('/boom').expect(500)
    const logs = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(logs).toContain('"logKey":"HTTP_REQUEST_SERVER_ERROR"')
  })
})
```

**Acceptance criteria:**

- [ ] 3+ e2e specs, each isolated (afterEach cleans state)
- [ ] `pnpm test:e2e` passes
- [ ] E2E does not use real Redis / external services — only in-memory + supertest

### 5.6 Mutation testing baseline

**Goal:** Establish the mutation score baseline. It is not a CI gate, but is executed once at the end of Phase 4 to identify weak tests.

**Command:**

```bash
pnpm mutation:dry-run  # first ensure config ok
pnpm mutation           # full run, ~10-20 min
```

**Expected output:** `reports/mutation/mutation.html` + `reports/stryker-incremental.json`.

**Acceptance criteria:**

- [ ] Mutation score ≥ 99% global (Stryker `break: 95, low: 95, high: 99`)
- [ ] Mutation score 100% on identified critical paths (normalize-url, validate-options, compile-redact-paths.util, trace-context-mixin)
- [ ] "Equivalent" mutants documented inline with `// Stryker disable next-line <Mutator>: <reason>`

### 5.7 Phase 4 validation

**Final commands:**

```bash
pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size && pnpm mutation
```

**Done criteria:**

- [ ] 100% coverage (release gate via `jest.coverage.config.ts`)
- [ ] Bundle within budgets
- [ ] Mutation score ≥ 99%
- [ ] E2E suite passes
- [ ] PR `phase-4` approved

---

## 6. Phase 5 — Release v0.1.0

> **Phase goal:** Complete documentation, CI workflows, end validation, tag, and publish.
>
> **Complexity:** LOW — predominantly mechanical (copy + adapt configs from nest-auth, write README based on the spec, run release workflow). Residual risk: fine-tuning bundle budgets when the real `dist/` is measured.

### 6.1 README

**Files to create:**

- `README.md` (~10-15 KB)

**Structure (mirrors `nest-auth/README.md`):**

```markdown
<p align="center">badges</p>
<h1 align="center">@bymax-one/nest-logger</h1>

## ✨ Overview

## 🔥 Features

## 📦 Subpath Exports

## 🚀 Quick Start (dev, prod with Loki, custom destination)

## 🧩 Configuration (link to spec §4)

## 🔌 Bring Your Own Destination

## 🔍 OpenTelemetry Correlation

## 📊 Default Redact Paths

## 🧪 Testing

## 🤝 Contributing

## 📜 License
```

**Acceptance criteria:**

- [ ] 3 complete usage scenarios (copy-pasteable)
- [ ] Badges: npm version, CI status, coverage, mutation, scorecard, license
- [ ] Links to SECURITY.md, CHANGELOG.md, spec, plan

### 6.2 CHANGELOG.md

```markdown
# Changelog

## [0.1.0] - 2026-XX-XX

### Added

- Initial release
- Pino 10 backed `PinoLoggerService` with NestJS LoggerService interface compatibility
- Structured API following `MODULE_ACTION_RESULT` convention
- Optional OpenTelemetry trace context injection
- `AsyncLocalStorage` context propagation
- HTTP request/response logging interceptor
- Exception filter
- PrettyDevDestination for development
- Pluggable destinations via `ILogDestination` interface
- Decorators `@InjectLogger`, `@LogContext`, `@LogPerformance`
```

### 6.3 SECURITY.md, CLAUDE.md, AGENTS.md

Copy from `nest-auth/` and adapt name + scope.

### 6.4 CI workflows

Copy and adapt from `nest-auth/.github/workflows/`:

- `ci.yml`
- `codeql.yml`
- `release.yml`
- `scorecard.yml`

**Adaptations:**

- Replace `nest-auth` with `nest-logger` in references
- Adjust the matrix if needed (already Node 24 in both)

### 6.5 Bundle size budgets

**File:** `scripts/check-size.mjs`

```javascript
const BUDGETS = [
  { name: 'server (NestJS module)', path: 'dist/server/index.mjs', brotli: 12_000 },
  { name: 'shared (types + constants)', path: 'dist/shared/index.mjs', brotli: 3_500 }
]
```

**Acceptance:**

- [ ] `pnpm size` shows `server` < 12KB brotli, `shared` < 3.5KB brotli

### 6.6 Final mutation testing run

```bash
pnpm mutation
```

- [ ] Score ≥ 99% global, 100% on critical paths
- [ ] Update `docs/mutation_testing_results.md` with timestamp and score

### 6.6a Consumer dev-link integration smoke (GA gate)

**Goal:** Before publishing 0.1.0 to npm, prove the lib works end-to-end inside a real Bymax consumer app — not just in our fixture suite. This is the **GA gate**: if the smoke fails, do NOT cut the tag.

**Procedure:**

1. **Dev-link the lib** into a sample Bymax repo. Two equally acceptable options:
   - **Option A — pnpm global link** (preferred for iterative debugging):
     ```bash
     cd /Users/maximiliano/Documents/MyApps/bymax-one/nest-logger
     pnpm build
     pnpm link --global
     cd /Users/maximiliano/Documents/MyApps/bymax-one/<consumer-repo>   # e.g., bymax-fitness backend
     pnpm link --global @bymax-one/nest-logger
     ```
   - **Option B — `file:` protocol** (matches what a real `npm publish` would deliver more closely):
     ```jsonc
     // consumer's package.json
     {
       "dependencies": {
         "@bymax-one/nest-logger": "file:../bymax-one/nest-logger"
       }
     }
     ```
     Then `pnpm install` in the consumer.

2. **Wire `BymaxLoggerModule.forRootAsync({...})`** in the consumer's `app.module.ts`:
   ```typescript
   BymaxLoggerModule.forRootAsync({
     imports: [ConfigModule],
     inject: [ConfigService],
     useFactory: (cfg: ConfigService) => ({
       service: { name: cfg.get('SERVICE_NAME'), version: cfg.get('GIT_SHA') },
       level: cfg.get('LOG_LEVEL') ?? 'info',
       http: { isEnabled: true, shouldCaptureExceptions: true },
       otel: { shouldAutoInjectTraceContext: true }
     })
   })
   ```
3. Add `BymaxLoggerModule.useNestLogger(app)` in the consumer's `main.ts` after `NestFactory.create(AppModule, { bufferLogs: true })`.

4. **Hit `/health`** (or any existing endpoint):

   ```bash
   curl -s http://localhost:3000/health -H 'x-request-id: gate-test-001' | head
   ```

5. **Confirm in stdout**:
   - Structured JSON log line contains `"logKey":"HTTP_REQUEST_START"` and `"logKey":"HTTP_REQUEST_SUCCESS"`
   - `requestId` field is present and equals `gate-test-001`
   - If OTel SDK is active in the consumer, `traceId` (32-hex) is also present

**Acceptance criteria:**

- [ ] Smoke pass with the exact stdout log line captured and attached to the GA-gate PR description
- [ ] Screenshot or copy/paste of the structured JSON included in the PR description (`requestId` and, if applicable, `traceId` visible)
- [ ] `pnpm test:cov:all` still 100% in the lib after the smoke (no regression)
- [ ] No errors thrown during the consumer's app boot (capture stderr — must be empty)
- [ ] **This is the GA gate** — do NOT proceed to §6.7 (tag + publish) until this sub-step is signed off

**Validation commands:**

```bash
# In the lib repo:
pnpm build && pnpm link --global

# In the consumer repo:
pnpm link --global @bymax-one/nest-logger
pnpm start:dev
curl -s -H 'x-request-id: gate-test-001' http://localhost:3000/health
```

**Dependencies:** §6.1 (README must document `useNestLogger` wiring), §6.2 (CHANGELOG `[Unreleased]` entry), §6.5 (bundle within budget), §6.6 (mutation passes).

**Risks/Notes:**

- ⚠️ `pnpm link --global` does NOT exercise the published-tarball codepath. If the smoke reveals a packaging issue, switch to `pnpm pack` + install the resulting `.tgz` for a 100% accurate dress rehearsal.
- ⚠️ Document any deviations from the documented wiring in `02 - Areas/Bymax/_shared/Learnings.md` — they become onboarding gotchas for the next consumer integration.

### 6.7 Tag + publish

```bash
# 1. Bump
pnpm version 0.1.0

# 2. Push tag
git push --follow-tags

# 3. release.yml triggers → publishes with --provenance
```

**Acceptance:**

- [ ] Tag `v0.1.0` created
- [ ] Workflow `release.yml` green
- [ ] Package available at `https://www.npmjs.com/package/@bymax-one/nest-logger`
- [ ] "Provenance" badge appears on npm

---

## Appendix A — Dependency Graph

```
                  Phase 1 — Foundation
                          │
                          ▼
            ┌─────────────────────────────┐
            │  PinoLoggerService base     │ ← §2.7
            │  BymaxLoggerModule.forRoot  │ ← §2.8
            │  DefaultStdoutDestination    │ ← §2.6
            └─────────┬───────────────────┘
                      │
                      ▼
                  Phase 2 — Context + OTel
                      │
            ┌─────────────────────────────┐
            │  LogContextService           │ ← §3.1
            │  TraceContextMixin           │ ← §3.3
            │  RequestIdMiddleware         │ ← §3.5
            └─────────┬───────────────────┘
                      │
                      ▼
                  Phase 3 — HTTP
                      │
            ┌─────────────────────────────┐
            │  HttpLoggingInterceptor      │ ← §4.2
            │  HttpExceptionFilter         │ ← §4.3
            │  Decorators                  │ ← §4.4
            └─────────┬───────────────────┘
                      │
                      ▼
                  Phase 4 — Production-ready
                      │
            ┌─────────────────────────────┐
            │  PrettyDevDestination       │ ← §5.1
            │  DestinationRegistry        │ ← §5.2
            │  Truncation                 │ ← §5.3
            │  forRootAsync               │ ← §5.4
            │  @InjectLogger context fac. │ ← §5.4a (E1)
            │  useNestLogger(app) helper  │ ← §5.4b (E2)
            │  sanitize-error.util        │ ← §5.4c (E3)
            │  Performance benchmark      │ ← §5.4d (E5)
            │  E2E suite + mutation       │ ← §5.5, §5.6
            └─────────┬───────────────────┘
                      │
                      ▼
                  Phase 5 — Release
                      │
            ┌─────────────────────────────┐
            │  Docs + CI + bundle         │ ← §6.1-§6.5
            │  Mutation final             │ ← §6.6
            │  Consumer dev-link (GA gate)│ ← §6.6a (E6)
            │  Tag + publish              │ ← §6.7
            └─────────────────────────────┘
```

---

## Appendix B — Complexity Matrix

| Phase | Sub-step                                                               | Est. LoC                      | Complexity | Risk                                                |
| ----- | ---------------------------------------------------------------------- | ----------------------------- | ---------- | --------------------------------------------------- |
| 1     | 2.1 Scaffold                                                           | ~30 LoC + configs             | LOW        | Tooling version                                     |
| 1     | 2.1a Husky + commitlint + lint-staged                                  | ~20 LoC + configs             | LOW        | Hook bypass via `--no-verify`                       |
| 1     | 2.2 Shared types                                                       | ~80 LoC                       | LOW        | —                                                   |
| 1     | 2.3 Interfaces                                                         | ~120 LoC                      | LOW        | —                                                   |
| 1     | 2.4 Constants                                                          | ~80 LoC                       | LOW        | —                                                   |
| 1     | 2.5 Config (validate, defaults, redact)                                | ~150 LoC                      | MEDIUM     | Low mutation score if tests are superficial         |
| 1     | 2.6 DefaultStdoutDestination                                           | ~25 LoC                       | LOW        | —                                                   |
| 1     | 2.7 PinoLoggerService base                                             | ~180 LoC                      | MEDIUM     | "last param = context" heuristic                    |
| 1     | 2.8 BymaxLoggerModule (LOG-024a sync + LOG-024b async — split per E12) | ~100 LoC                      | MEDIUM     | Global module + tokens; sync/async path divergence  |
| 1     | 2.9 Barrel + exports                                                   | ~25 LoC                       | LOW        | —                                                   |
| 1     | 2.10 Phase 1 tests                                                     | ~600 LoC                      | MEDIUM     | —                                                   |
| 2     | 3.1 LogContextService                                                  | ~50 LoC                       | LOW        | —                                                   |
| 2     | 3.2 OTel detector                                                      | ~40 LoC                       | MEDIUM     | ESM/CJS interop                                     |
| 2     | 3.3 TraceContextMixin                                                  | ~50 LoC                       | MEDIUM     | Valid span detection; Pino 10 mixin 3-arg signature |
| 2     | 3.4 Mixin integration                                                  | ~30 LoC modification          | MEDIUM     | —                                                   |
| 2     | 3.5 RequestIdMiddleware                                                | ~40 LoC                       | LOW        | —                                                   |
| 2     | 3.7 Phase 2 tests                                                      | ~400 LoC                      | MEDIUM     | Mock AsyncLocalStorage                              |
| 3     | 4.1 normalizeUrl                                                       | ~30 LoC                       | LOW        | Regex precision                                     |
| 3     | 4.2 HttpLoggingInterceptor                                             | ~120 LoC                      | MEDIUM     | —                                                   |
| 3     | 4.3 HttpExceptionFilter                                                | ~60 LoC                       | LOW        | —                                                   |
| 3     | 4.4 Decorators                                                         | ~150 LoC                      | MEDIUM     | @InjectLogger context                               |
| 3     | 4.5 Module integration                                                 | ~30 LoC                       | LOW        | —                                                   |
| 3     | 4.7 Phase 3 tests                                                      | ~600 LoC                      | MEDIUM     | Mock supertest                                      |
| 4     | 5.1 PrettyDevDestination                                               | ~50 LoC                       | LOW        | Optional peer dep                                   |
| 4     | 5.2 DestinationRegistry                                                | ~80 LoC + multi-stream wiring | HIGH       | Pino multi-stream subtleties                        |
| 4     | 5.3 Truncation                                                         | ~40 LoC                       | LOW        | —                                                   |
| 4     | 5.4 forRootAsync                                                       | ~100 LoC                      | MEDIUM     | NestJS async pattern                                |
| 4     | 5.4a @InjectLogger context wiring (child-logger factory)               | ~60 LoC                       | MEDIUM     | child-logger inheritance semantics                  |
| 4     | 5.4b useNestLogger(app) helper                                         | ~30 LoC                       | LOW        | bufferLogs:true ordering                            |
| 4     | 5.4c sanitize-error.util                                               | ~100 LoC                      | MEDIUM     | AggregateError + cause chain + circular refs        |
| 4     | 5.4d Performance benchmark                                             | ~80 LoC                       | MEDIUM     | Benchmark noise; CI regression budget               |
| 4     | 5.5 E2E suite                                                          | ~400 LoC                      | MEDIUM     | Isolation between specs                             |
| 4     | 5.6 Mutation baseline                                                  | manual                        | MEDIUM     | Equivalent mutants                                  |
| 5     | 6.1-6.6 Docs+CI+bundle+mutation                                        | manual                        | LOW        | —                                                   |
| 5     | 6.6a Consumer dev-link smoke (GA gate)                                 | manual                        | MEDIUM     | Real-consumer-only failures                         |
| 5     | 6.7 Tag + publish                                                      | manual                        | LOW        | —                                                   |

**Total estimated LoC (source + tests):** ~4,300 LoC (includes the four added Phase 4 sub-steps and Husky tooling).

---

## Appendix C — Reference Configs (mirror of nest-auth)

| File                      | Source to copy (and adapt)                                                             |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `tsconfig.json`           | [nest-auth/tsconfig.json](/Users/maximiliano/Documents/MyApps/nest-auth/tsconfig.json) |
| `tsconfig.build.json`     | nest-auth/tsconfig.build.json                                                          |
| `tsconfig.server.json`    | nest-auth/tsconfig.server.json                                                         |
| `tsconfig.e2e.json`       | nest-auth/tsconfig.e2e.json                                                            |
| `tsconfig.jest.json`      | nest-auth/tsconfig.jest.json                                                           |
| `jest.config.ts`          | nest-auth/jest.config.ts (adapt moduleNameMapper for 2 subpaths)                       |
| `jest.coverage.config.ts` | nest-auth/jest.coverage.config.ts (release threshold 100%)                             |
| `jest.e2e.config.ts`      | nest-auth/jest.e2e.config.ts                                                           |
| `jest.stryker.config.ts`  | nest-auth/jest.stryker.config.ts                                                       |
| `stryker.config.json`     | nest-auth/stryker.config.json (threshold high 99, low 95, break 95)                    |
| `eslint.config.mjs`       | nest-auth/eslint.config.mjs (remove crypto/oauth rules)                                |
| `.prettierrc`             | nest-auth/.prettierrc                                                                  |
| `.gitignore`              | nest-auth/.gitignore                                                                   |
| `scripts/check-size.mjs`  | nest-auth/scripts/check-size.mjs (adapt BUDGETS for 2 entries)                         |
| `.github/workflows/*.yml` | nest-auth/.github/workflows/\*.yml (replace repo name)                                 |

---

## Appendix D — Glossary and term mapping

| Term                       | Meaning in this plan                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| **Phase**                  | Cohesive feature block that delivers a vertical slice of the lib           |
| **Sub-step**               | §N.M inside a phase — atomic to become 1+ task in `development_tasks.md`   |
| **Acceptance criteria**    | Binary checklist (yes/no) for closing the sub-step                         |
| **Validation command**     | Exact command to run to validate acceptance                                |
| **Done criteria**          | Aggregate set of gates for closing the entire phase                        |
| **AAA pattern**            | Arrange/Act/Assert — convention in tests                                   |
| **TDD red-green-refactor** | Write a failing test → implement the minimal → refactor                    |
| **Mutation score**         | % of mutations detected by tests (Stryker)                                 |
| **Coverage gate**          | Minimum coverage threshold per file / global                               |
| **Multi-stream (Pino)**    | Pino feature to send 1 log to multiple destinations with per-level filters |
| **Mixin (Pino)**           | Function that returns additional fields merged into each entry             |
| **Serializer (Pino)**      | Function that normalizes an object type for JSON-safe output               |
| **AsyncLocalStorage**      | Node.js API for context propagation through async chains                   |

---

## Appendix E — Risks & Mitigations

Cross-cutting risks the plan accepts knowingly. Each one has a concrete mitigation that lands in a phase or in ongoing maintenance.

| #      | Risk                                                                                                                                                                                                                                                                                                                          | Mitigation                                                                                                                                                                                                                                                                                                                                                                                    | Phase / Owner                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **R1** | **OTel API churn.** `@opentelemetry/sdk-node` is pre-1.0 (currently `0.218`). A minor bump (`0.219`) can ship breaking changes that ripple into our trace-context mixin.                                                                                                                                                      | Pin the consumer-visible range to `>=0.218.0 <1.10.0` in peer dependencies. Add a CI **smoke job** that boots a Nest fixture with `@opentelemetry/sdk-node`, performs one HTTP request, asserts `traceId` (32 hex) appears in stdout. Job runs on every PR + weekly cron against the latest OTel release.                                                                                     | Phase 2 (§3.2 mixin) + ongoing CI |
| **R2** | **Pino 10 migration.** Pino has historically shipped major versions every 12-18 months. v11 will land within v0.1.x's GA window.                                                                                                                                                                                              | Track Pino release cadence in `CHANGELOG.md` under a `## Tracked Upstream` heading. Integration suite runs against Pino latest **weekly via CI matrix** (`pino: [10.x, latest]`). Lock our `peerDependencies` to `pino: ^10.0.0` and bump on a confirmed-green run.                                                                                                                           | Ongoing CI                        |
| **R3** | **Mixin signature change.** Pino 10 mixin signature is `(mergeObject, level, logger?) => object` — different from Pino 8's `(mergeObject) => object`. Calling code that forgets the new args silently passes `undefined` and looks correct but loses level-conditional logic.                                                 | Lock our `createTraceContextMixin` return type with an exact `(mergeObject: Record<string, unknown>, level: number, logger: PinoLogger) => Record<string, unknown>` signature (already in §3.3). Add a smoke test that asserts mixin is called with **3 args** by Pino — not 0 — by spying on the mixin function and triggering a real `pino.info(...)`.                                      | Phase 2 (§3.7 tests)              |
| **R4** | **Redact false negatives.** The 113-path `DEFAULT_REDACT_PATHS` is generated from `depth(field)`. A new sensitive field added to a Bymax service (e.g., `taxId`, `nationalIdNumber`) does NOT inherit redaction automatically.                                                                                                | Schedule a **yearly audit task** in `02 - Areas/Bymax/_shared/Conventions.md` (`Q1 each year: review PII fields across Bymax services and extend DEFAULT_REDACT_PATHS`). Bench (§5.4d) gates 113-path performance — adding paths must not violate the 5% redact-cost budget.                                                                                                                  | Annual audit + bench gate         |
| **R5** | **Worker-thread caveat.** `thread-stream` destinations (`pino.transport({ target: ... })`) run in a worker thread and **cannot read AsyncLocalStorage** — ALS is per-thread, not shared. A consumer who wires both `transport:` AND expects `requestId` in their custom destination will see `requestId` go missing silently. | Document explicitly in `docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md` (mandatory section: "Worker-thread destinations are blind to ALS — propagate context via the mixin output, not via ALS reads in the destination"). Add a benchmark scenario in §5.4d using `transport: { target: 'pino/file' }` and one using direct `ILogDestination` to make the perf trade-off visible. | Phase 4 (§5.4d + guidelines)      |

**Maintenance protocol:** review this table at every minor release. New risks discovered in production go here first, then graduate to a phase or to `02 - Areas/Bymax/_shared/Learnings.md` if they become canonical.

---

## Appendix F — Contract Stability & Semver Policy

This appendix governs every public symbol the lib exposes. It is referenced by §6.7 (release) and by every future PR that touches the public surface.

### Public API surface

The following symbols form the **public contract**. Any change to their shape, signature, or removal is a **breaking change**:

- **Classes:** `BymaxLoggerModule`, `PinoLoggerService`, `LogContextService`, `DefaultStdoutDestination`, `PrettyDevDestination`, `HttpLoggingInterceptor`, `HttpExceptionFilter`, `RequestIdMiddleware`, `DestinationRegistry`
- **Interfaces:** `ILogDestination`, `LogContext`, `BymaxLoggerModuleOptions`, `BymaxLoggerModuleAsyncOptions`, `BymaxLoggerModuleOptionsFactory`, `HttpOptions`, `OtelOptions`, `LogEntry`, `ServiceMetadata`, `SanitizedError`
- **Types:** `LogLevel`, `ReservedLogKey`
- **Decorators:** `@InjectLogger`, `@LogContext`, `@LogPerformance`
- **Constants & tokens (everything exported from `errors/` and `services/` barrels):**
  `LOGGER_OPTIONS_TOKEN`, `LOGGER_PINO_INSTANCE_TOKEN`, `LOGGER_DESTINATIONS_TOKEN`, `LOG_CONTEXT_TOKEN`, `LOG_CONTEXT_METADATA_KEY`, `DEFAULT_REDACT_PATHS`, `LOG_KEYS_CONVENTION_REGEX`, `RESERVED_LOG_KEYS`, `PINO_LEVEL_NUMBERS`, `PINO_LEVEL_NAMES`, `NEST_TO_PINO_LEVEL`
- **Helpers:** `applyRequestIdMiddleware`, `BymaxLoggerModule.useNestLogger`, `createInjectLoggerProvider`

### Semver rules

| Change                                                                           | Bump                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| Removing or renaming any public symbol above                                     | **MAJOR**                                       |
| Removing or renaming any field on a public interface above                       | **MAJOR**                                       |
| Tightening a parameter type (narrowing)                                          | **MAJOR**                                       |
| Changing default behavior in a way that produces different runtime output        | **MAJOR**                                       |
| Adding a NEW optional field to `ILogDestination` (default-implemented)           | **MINOR**                                       |
| Adding a NEW field to `BymaxLoggerModuleOptions` (optional, with a safe default) | **MINOR**                                       |
| Adding a NEW exported symbol (class, function, constant, decorator)              | **MINOR**                                       |
| Loosening a parameter type (widening)                                            | **MINOR**                                       |
| Bug fix that does NOT change documented behavior                                 | **PATCH**                                       |
| Internal refactor with no public-surface change                                  | **PATCH**                                       |
| Doc-only change                                                                  | **PATCH** (chore: in commits — no version bump) |

### Deprecation policy

When a public symbol must be removed:

1. **One minor cycle of deprecation warnings** before removal:
   - Add `@deprecated <reason and migration hint>` JSDoc tag on the symbol
   - Emit a `console.warn` **once per process** (use a `Set<symbol>` cache) the first time the deprecated symbol is touched at runtime
   - Add an entry under `## Deprecated` in `CHANGELOG.md` for that minor release
2. **Remove in the NEXT major** (not the next minor).
3. The CHANGELOG entry for the major release MUST link back to the minor release that flagged the deprecation.

### Tooling: Conventional Commits drives the bump

Conventional Commits (enforced by §2.1a Husky + commitlint) drive the semver bump via **either** `changesets` (preferred — explicit per-PR intent, lets multiple PRs accumulate into one release) **or** `semantic-release` (automatic bump from commit log). **Pick one** and add a sub-step in Phase 5 (`§6.7a Release tooling — changesets`) that:

- Adds the chosen tool to devDependencies
- Wires `release.yml` to run it
- Documents the contributor workflow in `CONTRIBUTING.md`

**Recommendation:** start with `changesets` for v0.1.x — the explicit intent file (`.changeset/<random>.md`) per PR makes the bump audit-able in code review, which matters more during the early API churn.

---

> **Next phase of this document:** generate `development_tasks.md` (Layer 3 — AI-agent-executable tasks) using this plan as input and the template in [`/bymax-workflow:phase-tasks`](../../../.claude/commands/bymax-workflow/phase-tasks.md).
