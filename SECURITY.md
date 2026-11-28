# Security Policy

`@bymax-one/nest-logger` ships structured logging primitives — PII redaction, trace context injection, and destination routing — that downstream applications rely on to avoid leaking sensitive data in logs. We take vulnerability reports seriously and triage them ahead of feature work.

## Supported versions

Only the most recent minor receives security fixes; upgrade to it.

| Version | Status                              |
| ------- | ----------------------------------- |
| `1.5.x` | ✅ Active — receives security fixes |
| `< 1.5` | ❌ End-of-life                      |

## Reporting a vulnerability

**Do not report security issues through public GitHub Issues, Discussions, or pull requests.** Public reports give attackers a window between disclosure and patch deployment.

Use GitHub **Private Vulnerability Reporting**, which is enabled on this repository:

➡️ [Open a private security advisory](https://github.com/bymaxone/nest-logger/security/advisories/new)

If you cannot use the GitHub form (e.g., you do not have an account), email **support@bymax.one** with `[security] @bymax-one/nest-logger` in the subject line.

### What to include

A useful report contains:

- A clear description of the vulnerability and its impact (CIA triad — confidentiality, integrity, availability)
- Step-by-step reproduction against the latest `1.x` release
- The affected subpath (`.`, `./shared` or `./observability`)
- A suggested fix or mitigation, if you have one
- Whether you would like to be credited in the published advisory (and how — name, handle, affiliation)

### Response timeline

| Phase                                   | Target                                |
| --------------------------------------- | ------------------------------------- |
| Acknowledgement of receipt              | within **72 hours**                   |
| Initial assessment and severity rating  | within **7 days**                     |
| Coordinated fix for **Critical / High** | within **90 days** of acknowledgement |
| Coordinated fix for **Medium / Low**    | best effort, tracked in advisory      |

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure) and publish the advisory only after a fixed version is on npm, unless active exploitation forces an earlier publication.

Reporters are credited in the GitHub Security Advisory and CHANGELOG entry unless they request anonymity.

## In-scope vulnerabilities

The following classes are explicitly in scope:

- **PII leakage via logs** — any path where `DEFAULT_REDACT_PATHS` or consumer-provided redact paths fail to suppress sensitive values (passwords, tokens, payment data, CPF/CNPJ, email)
- **Log injection / log forging** — any path that allows an external actor to inject structured fields, spoofing `logKey`, `userId`, `traceId`, or `service` metadata
- **Trace context spoofing** — injection of crafted `traceId`/`spanId` values through user-controlled HTTP headers that bypass `isValidTraceId` validation
- **Destination write escalation** — a custom `ILogDestination` that can be made to write to paths or endpoints it should not access by manipulating log entry content
- **Bundle supply-chain integrity** — compromised dependency, malicious typosquat, tampered release artifact
- **CodeQL `security-extended` alerts** — anything the automated scan surfaces in the Security tab

## Threat model: same-process code

Code that runs inside the host process is trusted, as in Node's own threat model: it can replace builtins, prototypes, `Promise` and the logger's own modules, and nothing in a library can stop it. The in-process guards of this package (the promise baseline, the captured built-ins, the options read past `Object.prototype`, the own-field reads of descriptors) are best-effort hardening against prototype pollution and accidental replacement. They are not a security boundary, and a report that needs hostile code already running in the process is out of scope. Known limits, in one line: a frozen or sealed native promise under a replaced `Promise.prototype.constructor`, a species getter that makes a temporary slot non-configurable, a `then` planted and erased between a check and the wait, and built-ins the capture table does not list.

## Known limits

Under `redactStrategy: 'paths'`, a binary value that a `toJSON` returns into the message argument or a `%o`, `%O` or `%j` placeholder of the raw logger, or a child bindings field, is written byte by byte. Record fields and service calls write its size. Return a plain value from `toJSON` instead.

Binary values written as text:

- A `stack` that your code defines as an enumerable own property is a field of yours and is written as defined, whatever text it holds.
- An error whose `message` getter throws keeps a `stack` that your code defined on it, unchanged.
- With every redaction off (`shouldDisableDefaultRedact: true`, no `redactPaths`, `errorOwnFields` not `'safe'`), a Buffer held in an object inside `err`, or in a thrown plain object, is written as bytes.
- A structured call such as `info(logKey, message)` given a Buffer as the message throws. So does the raw logger under `redactStrategy: 'paths'` when `err.message` is a Buffer.
- Under `redactStrategy: 'names'`, a plain object under `err` whose `message` is an array with a `length` near 2^31 exhausts memory.

Convert such values to text before you log them.

## Out of scope

These are not vulnerabilities in `@bymax-one/nest-logger` itself:

- Issues only reproducible in versions older than `1.4.0`
- Misconfigurations in the **consuming application** (e.g., disabling default redact paths via `shouldDisableDefaultRedact: true`, passing secrets as log metadata) unless they reproduce with the documented default configuration
- Issues in optional peer dependencies (`pino-pretty`, `@opentelemetry/api`) when the upstream maintainer has already accepted them or when the dependency is not exercised by the library
- Self-XSS, social engineering, denial of service via legitimate authenticated load
- Theoretical attacks without a practical demonstration
- Attacks that need hostile code already running in the host process (see the threat model above)

## Security best practices for consumers

The repository documentation covers deployment hardening:

- [docs/guidelines/PINO-REDACTION-GUIDELINES.md](docs/guidelines/PINO-REDACTION-GUIDELINES.md) — PII redaction paths, `fast-redact` wildcard semantics, extending defaults
- [docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md](docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md) — trace context injection, `isValidTraceId` invariants
- [docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md](docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md) — safe destination implementation patterns

Pin the package to an exact version in production, verify the publish provenance (`npm audit signatures`), and subscribe to the repository's security advisories so you receive notifications when a CVE is published.

## Acknowledgements

We are grateful to the security community and to every reporter who takes the time to investigate and disclose responsibly.
