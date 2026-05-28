# Pino Redaction Guidelines — `@bymax-one/nest-logger`

> **Version:** 1.0.0
> **Last updated:** 2026-05-27
> **Target:** Pino 10.x, fast-redact 3.x
> **Related document:** `docs/technical_specification.md` §10, `src/server/constants/default-redact-paths.constants.ts`

---

## Table of Contents

1. [Why declarative redaction](#1-why-declarative-redaction)
2. [How `pino.redact` works under the hood](#2-how-pinoredact-works-under-the-hood)
3. [Path syntax — what works and what does NOT](#3-path-syntax)
4. [Default registry (`DEFAULT_REDACT_PATHS`)](#4-default-registry)
5. [How to extend safely](#5-how-to-extend-safely)
6. [Compliance — LGPD, GDPR, PCI DSS](#6-compliance)
7. [Auditing the registry at runtime](#7-auditing-the-registry-at-runtime)
8. [Performance budget](#8-performance-budget)
9. [Anti-patterns](#9-anti-patterns)
10. [Test checklist](#10-test-checklist)

---

## 1. Why declarative redaction

Production logs flow through multiple layers (stdout → local agent → OTLP backend → storage → query). Every hop is an opportunity for **PII or credential leakage** if the application logs sensitive data literally. Possible strategies:

| Strategy                                               | Trade-off                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| **Don't log anything structured**                      | Kills observability                                             |
| **Manual redaction at each call site**                 | Easy to forget; high human risk                                 |
| **Downstream sanitization (in the Loki/Vector agent)** | Delays protection; the leak is already in stdout                |
| **Centralized declarative redaction** ✅               | Single source of truth; compiled at init; zero per-log overhead |

The lib adopts the declarative option via `pino.redact` (`fast-redact` engine).

---

## 2. How `pino.redact` works under the hood

`fast-redact` (`davidmarkclements/fast-redact`) takes the list of paths and **compiles a specialized JavaScript function** via `new Function(...)` at initialization. That function:

1. Accesses each path directly (no regex, no tree-walking)
2. Replaces the value with the configured `censor` (`'[REDACTED]'` by default)
3. Restores the original value after JSON serialization (it does not mutate the caller's object)

**Per-log impact:** ~3% with 100 paths; ~5% with 200 paths. Above 200, consider a custom serializer.

```typescript
// What happens in ms-zero:
const compiled = fastRedact({
  paths: ['*.password', 'req.headers.authorization'],
  censor: '[REDACTED]'
})
const logEntry = { req: { headers: { authorization: 'Bearer xyz' }, body: { password: 'secret' } } }
const safeJson = compiled(logEntry)
// → '{"req":{"headers":{"authorization":"[REDACTED]"},"body":{"password":"[REDACTED]"}}}'
```

---

## 3. Path syntax

### 3.1 What works

| Pattern                      | Match                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `'a.b.c'`                    | Absolute path — `obj.a.b.c`                                |
| `'*.password'`               | Any `password` key at **one level** (direct child of root) |
| `'*.*.password'`             | Any `password` at **two levels**                           |
| `'req.headers["x-api-key"]'` | Bracket syntax for keys with hyphens/quotes                |
| `'arr[0].secret'`            | Fixed array index                                          |
| `'arr[*].secret'`            | Array wildcard (any index)                                 |

### 3.2 What does **NOT** work

⚠️ **Recursive wildcard (`**`) does NOT exist.\*\*

```typescript
// You expect: redact password at any depth ❌
redactPaths: ['**.password'] // ERROR — invalid syntax in fast-redact

// You expect: redact password recursively ❌
redactPaths: ['*.password'] // Only redacts password at 1 level
```

**Solution**: list paths by depth explicitly:

```typescript
const depth = (field: string) => ['*', '*.*', '*.*.*', '*.*.*.*'].map((p) => `${p}.${field}`)

redactPaths: [
  ...depth('password'), // generates ['*.password', '*.*.password', '*.*.*.password', '*.*.*.*.password']
  ...depth('cpf')
  // ...
]
```

The lib applies this strategy by default — see §4.

### 3.3 Edge cases

- **`undefined` in path**: `fast-redact` silently ignores (does not throw).
- **Duplicate path**: `fast-redact` 3.x throws on duplicate paths in the input array. Always dedupe before passing: `Array.from(new Set(paths))`. The lib's `compileRedactPaths` util (at `src/server/utils/compile-redact-paths.util.ts`) does this automatically.
- **Reserved words in path**: use bracket syntax: `'obj["new"]'` instead of `'obj.new'`.

---

## 4. Default registry

See the canonical file: [`src/server/constants/default-redact-paths.constants.ts`](../../src/server/constants/default-redact-paths.constants.ts).

**Current coverage (97 total paths — 92 via `depth()` + 5 absolute paths):**

| Category            | Fields (count)                                                                  | Depth | Generated paths |
| ------------------- | ------------------------------------------------------------------------------- | ----- | --------------- |
| Passwords           | 5 (`password`, `passwordHash`, `passwordConfirm`, `newPassword`, `oldPassword`) | 1-4   | 20              |
| Tokens              | 6 (`token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `apiSecret`)    | 1-4   | 24              |
| MFA                 | 3 (`mfaSecret`, `mfaRecoveryCodes`, `totpSecret`)                               | 1-4   | 12              |
| Payment (PCI DSS)   | 5 (`cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`)                         | 1-4   | 20              |
| BR documents (LGPD) | 3 (`cpf`, `cnpj`, `rg`)                                                         | 1-4   | 12              |
| Email (PII)         | 1 (`email`)                                                                     | 1-4   | 4               |
| HTTP headers        | 5 (absolute paths)                                                              | —     | 5               |
| **Total**           | **23 fields via depth + 5 absolute**                                            | —     | **97**          |

### When the consumer SHOULD extend

- Domain-specific tokens (`*.gameServerKey`, `*.webhookSignature`)
- Additional BR documents (`*.tituloEleitor`, `*.cnh`)
- Sensitive internal IDs if LGPD requires (`*.cpfClienteFinal`)

### When NOT to redact

- Internal IDs (`userId`, `accountId`) — needed for query/correlation
- Timestamps, levels, technical metrics
- Service metadata (`service.name`, `service.version`)

---

## 5. How to extend safely

> The merge + dedupe logic lives in `compileRedactPaths` at `src/server/utils/compile-redact-paths.util.ts` (note: `utils/`, not `config/`). It accepts the consumer's `redactPaths` array and the `disableDefaultRedact` flag, merges with `DEFAULT_REDACT_PATHS`, dedupes via `Array.from(new Set(...))`, and returns the compiled path list passed to `pino.redact`.

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'finance-api', version: '1.2.3' },
  redactPaths: [
    // adds, does not replace
    '*.gameServerKey',
    '*.webhookSignature',
    'body.creditCard.*', // redacts ALL fields inside creditCard
    'res.body.secret' // absolute path
  ]
})
```

The lib **merges** with `DEFAULT_REDACT_PATHS` (does not replace). To fully replace (dangerous):

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'finance-api', version: '1.2.3' },
  disableDefaultRedact: true,
  redactPaths: ['*.password']
})
```

> ⚠️ `disableDefaultRedact: true` emits a bootstrap warning (`LOGGER_BOOTSTRAP_WARNING`). The `compileRedactPaths` util's hot-path dedup MAY look like dead code to Stryker — but it's load-bearing. Add a JSDoc comment explaining the dedup intent so Stryker mutations leave the dedup logic intact, and keep mutation coverage on the function as a whole.

### Custom censor

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactCensor: '***'
})
```

Censor can be a function (preserves type):

```typescript
redactCensor: (value, path) =>
  typeof value === 'number' ? 0 : typeof value === 'string' ? '' : null
```

---

## 6. Compliance

### LGPD (Brazil) — Article 14 "sensitive personal data"

Lib default fields covering LGPD: `email`, `cpf`, `cnpj`, `rg`. Additional fields to consider per app scope: `tituloEleitor`, `cnh`, `nis`, phone number.

> **Name alone is NOT PII under LGPD Art. 5 III** (it's only PII when combined with identifying context). Do NOT redact `nome` by default — that breaks legitimate logging of audit trails (`AUDIT_USER_NAMED_<X>`). Redact only when combined with identifying data (CPF, email).

> ⚠️ **`email`** is in the default list but can be disabled if the app justifies logging (e.g., multi-tenant authentication where email is the primary identifier). Conscious decision.

### GDPR (EU)

Covered fields: `email`. Add per scope: `phoneNumber`, `address`, `dateOfBirth`, `ipAddress`. **Note**: `ipAddress` is PII under GDPR but frequently required in HTTP logs — conscious decision.

### PCI DSS

Covered: `cardNumber`, `cvv`/`cvc`, `cardExpiry`, `cardCvv`. **NEVER** log full PAN, CVV, or track data. The lib redacts by default; the consumer MUST NOT override.

---

## 7. Auditing the registry at runtime

```typescript
import { Inject, Injectable } from '@nestjs/common'
import {
  LOGGER_OPTIONS_TOKEN,
  DEFAULT_REDACT_PATHS,
  type BymaxLoggerModuleOptions
} from '@bymax-one/nest-logger'

@Injectable()
export class LogAuditService {
  constructor(@Inject(LOGGER_OPTIONS_TOKEN) private readonly opts: BymaxLoggerModuleOptions) {}

  /** Returns the effective list of redact paths (default + custom). */
  listActiveRedactPaths(): readonly string[] {
    if (this.opts.disableDefaultRedact) return this.opts.redactPaths ?? []
    return Array.from(new Set([...DEFAULT_REDACT_PATHS, ...(this.opts.redactPaths ?? [])]))
  }

  /** CI gate: ensure expected paths are present. */
  assertRequiredPathsPresent(required: readonly string[]): void {
    const active = new Set(this.listActiveRedactPaths())
    for (const p of required) {
      if (!active.has(p)) throw new Error(`Missing required redact path: ${p}`)
    }
  }
}
```

Use in **E2E tests** to ensure the app provides the paths the domain requires.

---

## 8. Performance budget

| # paths | Throughput impact | Recommendation                                            |
| ------- | ----------------- | --------------------------------------------------------- |
| ≤ 100   | < 3%              | No action                                                 |
| 100-200 | 3-5%              | Acceptable; monitor                                       |
| 200-400 | 5-10%             | Audit — likely redundant paths                            |
| > 400   | > 10%             | Refactor — use a custom serializer or group by sub-object |

The lib default sits at 97 paths — comfortably within the 100 budget.

---

## 9. Anti-patterns

❌ **Redacting level/timestamp**: breaks parseable JSON
❌ **Redact with invalid path**: silently does not work — always validate with a test
❌ **`redactCensor` that mutates the input**: a censor function MUST NOT mutate the received value
❌ **Logging before bootstrap**: `BymaxLoggerModule.forRoot` must complete before calling `logger.info`
❌ **Trusting `'**'`**: parses as a single literal star (fast-redact only supports single-level `\*`wildcard, never recursive`\*\*`). The path silently matches nothing — tests MUST verify each depth via the `depth(n)` helper, never assume recursive coverage.

---

## 10. Test checklist

Every deployment must have tests ensuring:

- [ ] `DEFAULT_REDACT_PATHS.length` matches the expected value (**97**)
- [ ] `compileRedactPaths(extras, false)` includes defaults AND extras, with no duplicates
- [ ] `compileRedactPaths(extras, true)` returns only extras
- [ ] A log with `{ password: 'x' }` produces JSON with `"password":"[REDACTED]"`
- [ ] A log with `{ user: { password: 'x' } }` produces `"password":"[REDACTED]"` (depth 2)
- [ ] A log with `{ a: { b: { c: { d: { password: 'x' } } } } }` (depth 5) does **not** redact (expected — outside the 4-level budget) — document in the test
- [ ] `redactCensor: '***'` replaces the value with `***`
- [ ] `disableDefaultRedact: true` emits a bootstrap warning

---

## References

- [fast-redact README](https://github.com/davidmarkclements/fast-redact)
- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
- [LGPD Law nº 13.709/2018](http://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- [GDPR Article 4 — definitions](https://gdpr-info.eu/art-4-gdpr/)
- [PCI DSS v4.0 Requirement 3 — protect stored account data](https://www.pcisecuritystandards.org/document_library/)
