---
applyTo: '**/*.spec.ts,**/*.e2e.spec.ts'
---

# Testing standards

## Coverage gate

`pnpm test:cov:all` enforces **100% statements, branches, functions, and lines**. Any PR that drops coverage below 100% on a touched source file must not be approved — it is a hard pre-publish gate, not a target.

## Mutation testing threshold

Break gate: **95%** (`thresholds.break: 95`). Current score is **97.42%** — the theoretical maximum given 10 documented equivalent mutants (see `docs/mutation_testing_results.md §Residual survivors`). The aspirational `high: 99` is not reachable without `// Stryker disable` comments, which are prohibited in this project (see below). Flag tests that use generic matchers (`toBeDefined()`, `toBeTruthy()`) where a value assertion is possible — they survive Stryker mutants.

## Test structure and naming

```
describe('ClassName')           →  class under test
  describe('#methodName()')     →  instance method (use . for static)
    it('should <outcome> when <condition>')
```

Every `it` must state the expected behaviour. Avoid `it('works')` or `it('returns value')`.

## Scope: public API only

Test through exported public interfaces only. Never access private class members or unexported internals. If behaviour is only verifiable through a private member, the design needs refactoring.

## Mutation-aware assertion patterns (required to kill Stryker mutants)

**1. Assert the value, not just existence:**

```typescript
// ❌ expect(result).toBeDefined()  — survives a value mutation
// ✅ expect(result.level).toBe('info')
```

**2. Test BOTH sides of every `||` / `&&`:**

```typescript
// Source: if (hasTraceId && hasSpanId) — must add a test with only one side true
// to kill the && → || mutation
```

**3. Assert field path AND message independently:**

```typescript
const err = errors.find((e) => e.path.includes('logKey'))
expect(err?.message).toBe('logKey is required') // kills path mutant and message mutant separately
```

**4. Cover the acceptance path of every filter/predicate:**

```typescript
// ❌ only testing rejection: ArrowFunction `() => undefined` mutation survives
// ✅ also test: expect(isValidLogKey('HTTP_REQUEST_START')).toBe(true)
```

## Stryker disable comments — PROHIBITED in this project

Do **not** add `// Stryker disable` inline comments. They ship verbatim in the unminified `.mjs` bundle (tsup `minify: false`) and push the server subpath past its 13.5 KiB brotli budget.

Equivalent mutants must be **documented in `docs/mutation_testing_results.md §Residual survivors`** instead, with an explanation of why the mutant is semantically equivalent. This is the canonical approach for this project.

## Log key assertions

Every test that asserts log output must verify `MODULE_ACTION_RESULT` format:

```typescript
expect(capturedKey).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+){2}$/)
```

`toBeTruthy()` or `toContain('_')` alone is insufficient.

## NestJS integration tests

Use `@nestjs/testing → Test.createTestingModule(...)`. Override only external I/O (Pino transport streams, OTel API). Keep all DI wiring real — do not stub services unless they are external.

## E2E tests (`*.e2e.spec.ts`)

Real NestJS app (`NestFactory.create`) + `supertest`. Must validate: HTTP interceptor emits correct log keys, exception filter captures errors, context propagation (`requestId`, `tenantId`) appears in every log entry of that request.

## Mocking Pino and OTel

- Capture log output via a writable stream passed to the destination — never spy on `console.*`.
- Mock `@opentelemetry/api` with `jest.mock('@opentelemetry/api')` — test both "OTel active" and "OTel absent" code paths for every feature that touches trace context.
- Restore all mocks in `afterEach` / `afterAll` — never leave module-level mocks bleeding across files.
