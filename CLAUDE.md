# @bymax-one/nest-logger — AI Agent Quick Reference

> **Type:** npm public library (NOT an application)
> **Package:** `@bymax-one/nest-logger` — structured JSON logging for NestJS 11 based on Pino 10, with optional OpenTelemetry correlation
> **Runtime:** Node.js 24+ | Zero direct dependencies (functionality via peer deps)

---

## Critical Rules

**1. npm Library — Not an App** (uses pnpm)

- Zero direct dependencies (`"dependencies": {}`). Everything is `peerDependency` or `node:` builtin.
- Define interfaces (`ILogDestination`) — never import concrete third-party implementations.
- Export public API from `src/{subpath}/index.ts`. Use `export type` for interfaces/types, `export` for classes/constants/decorators.

**2. English Only**

- All code, comments, JSDoc, variable names, and docs in English. JSDoc on every public export.
- Log messages emitted by the library itself use English and follow the `MODULE_ACTION_RESULT` convention (e.g., `LOGGER_BOOTSTRAP_OK`).

**3. TypeScript — Zero `any`**

- Never `any` in production code. Single documented exception: NestJS `LoggerService` variadic method signatures (`log`, `error`, `warn`, `debug`, `verbose`, `fatal`) — required for `app.useLogger()` compatibility. See spec §6.1.
- Use `unknown`, generics, or explicit types everywhere else.
- `strict: true` — no exceptions.

**4. Security — Non-Negotiable**

- Never log tokens, secrets, passwords, or keys — `DEFAULT_REDACT_PATHS` covers the standard set; extend via `redactPaths`.
- `DEFAULT_REDACT_PATHS` is append-only: new paths may only be added, never removed, without a major version bump.
- OTel trace IDs are validated with `isValidTraceId` before injection — never accept raw user-controlled input as a trace ID.
- A failing destination MUST NOT crash the app — `DestinationRegistry` wraps every `write()` in a try/catch and emits a meta-log.

**5. NestJS Patterns**

- Injection tokens: `Symbol()` — never strings.
- `@Inject(TOKEN)` must be explicit on every provider (tsup strips decorator metadata — implicit DI breaks in the published package).
- Dynamic module via `ConfigurableModuleBuilder` — `forRoot()` (sync) and `forRootAsync()` (async).
- No `Scope.REQUEST` — all providers are singletons.

**6. Code Style**

- Single quotes, no semicolons, 2-space indent. camelCase files, PascalCase classes.
- Import order: `node:` → external → internal → relative → types. One concern per file.

**7. Testing — TDD, 100% Coverage (hard gate)**

- Co-located unit tests (`*.spec.ts`). AAA pattern. Mock Pino instance and destinations in unit tests — never real I/O.
- E2E tests in `test/e2e/` using `@nestjs/testing`.
- **100% statements / branches / functions / lines** enforced by `jest.coverage.config.ts` (`pnpm test:cov:all`). Not a target — a pre-publish gate. Mutation testing (Stryker `break: 95`) is the deeper gate against weak tests.

**8. Build** — tsup builds 2 subpaths → ESM (.mjs) + CJS (.cjs) + .d.ts. `sideEffects: false`. Peer deps always external.

---

## Subpaths

| Subpath      | Purpose                       | Peer Deps                         |
| ------------ | ----------------------------- | --------------------------------- |
| `.` (server) | NestJS module + services      | NestJS 11, pino, reflect-metadata |
| `./shared`   | Types + constants (zero deps) | None                              |

---

## Verification — Run Before Completing Any Task

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

### Mutation testing (before tagging a release)

Line coverage is 100%, but mutation testing is the real gate against weak tests.
Run under Node 24:

```bash
pnpm mutation             # full run (~10-20 min); writes reports/mutation/mutation.html
pnpm mutation:incremental # faster re-run using reports/stryker-incremental.json
```

Equivalent mutants are documented inline with `// Stryker disable next-line <Mutator>: <reason>`.
Full setup, config rationale, and the iteration workflow live in
[docs/mutation_testing_plan.md](./docs/mutation_testing_plan.md). Do **not** add
mutation testing to `prepublishOnly` or the per-PR CI — it is a manual/release gate.

---

## Guidelines — Load Only What You Need

> **Do NOT load all guidelines at once.** Each is 30-80KB. Read only 1-2 relevant to your current task.

| Domain        | File                                                        | Load when...                          |
| ------------- | ----------------------------------------------------------- | ------------------------------------- |
| Pino          | `docs/guidelines/PINO-REDACTION-GUIDELINES.md`              | Modifying redact paths, Pino config   |
| OpenTelemetry | `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md`            | OTel mixin, trace context, detection  |
| Destinations  | `docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md` | Writing custom destinations           |
| NestJS        | (ad-hoc from spec §5–6)                                     | Dynamic module, interceptors, filters |
| TypeScript    | (ad-hoc from plan §1.2)                                     | Type design, barrel exports           |
| Testing       | (ad-hoc from plan §2.10, §3.5, etc.)                        | Writing or fixing tests               |

For full architecture and patterns, see **[AGENTS.md](./AGENTS.md)** (load on demand — not every session).
