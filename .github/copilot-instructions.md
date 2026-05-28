# nest-logger — Repository Instructions

`@bymax-one/nest-logger` is a public npm library that provides structured JSON logging for NestJS 11+ built on **Pino 10.x** with optional OpenTelemetry SDK 1.x trace correlation. Runtime: Node 24+. Package manager: pnpm.

## Commands

```bash
pnpm install          # install dev dependencies
pnpm typecheck        # tsc --noEmit (tsconfig.json + tsconfig.server.json)
pnpm lint             # ESLint on src/
pnpm test             # Jest unit tests
pnpm test:e2e         # Jest E2E tests (real NestJS bootstrap)
pnpm test:cov:all     # all tests with coverage — 100% gate (pre-publish enforced)
pnpm mutation         # Stryker mutation tests — score ≥ 99% required
pnpm build            # clean + tsup → dist/ (ESM + CJS + .d.ts for both subpaths)
```

## Source layout

```
src/
  server/     →  exported as "."          (NestJS-specific: services, module, interceptors, filters, decorators)
  shared/     →  exported as "./shared"   (types, constants, interfaces shared with consumers)
```

## Non-negotiable rules

1. **`package.json → "dependencies"` must remain empty** — every runtime requirement lives in `peerDependencies`. Adding a real dependency is a breaking change to the supply-chain contract.
2. **Log keys must follow `MODULE_ACTION_RESULT`** — three UPPER_SNAKE_CASE segments separated by underscores (e.g. `USER_AUTH_SUCCESS`, `HTTP_REQUEST_START`). Reject any key that deviates.
3. **Pino 10.x only** — Pino 9 is EOL and must never be referenced. Verify `pino` imports and version ranges.
4. **OTel is optional detection** — the library must build and run correctly when `@opentelemetry/api` is absent. Use try/catch dynamic import or optional peer detection, never a hard import at module scope.
5. **No `console.*` in `src/`** — all internal diagnostics go through the library's own logger (meta-logging pattern). ESLint enforces `no-console: warn` on source files.
6. **JSDoc on every export** — every exported `class`, `function`, `interface`, `type`, and `const` requires JSDoc with an `@example` block.
7. **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. PR titles and commit messages must comply.

## Architecture context

- Context propagation uses `AsyncLocalStorage` — `requestId`, `tenantId`, `userId`, `traceId`, `spanId` are stored there, never passed as function arguments.
- Pluggable destinations via `ILogDestination` interface — implementations must never be imported directly in core logic.
- `PinoLoggerService` implements the NestJS `LoggerService` interface AND exposes a custom `log(logKey, message, userId?, metadata?)` API.
- The custom API uses the `MODULE_ACTION_RESULT` convention (see rule 2 above).
