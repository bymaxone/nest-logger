# Security Policy

`@bymax-one/nest-logger` ships structured logging primitives — PII redaction, trace context injection, and destination routing — that downstream applications rely on to avoid leaking sensitive data in logs. We take vulnerability reports seriously and triage them ahead of feature work.

## Supported versions

Security patches are issued for the most recent minor on the active `0.x` line. Once v1.0 ships, the support table will be updated.

| Version | Status                              |
| ------- | ----------------------------------- |
| `0.1.x` | ✅ Active — receives security fixes |
| `< 0.1` | ❌ End-of-life                      |

If you are stuck on an older version and need a backport, open a private advisory (see below) and we will discuss feasibility on a case-by-case basis.

## Reporting a vulnerability

**Do not report security issues through public GitHub Issues, Discussions, or pull requests.** Public reports give attackers a window between disclosure and patch deployment.

Use GitHub **Private Vulnerability Reporting**, which is enabled on this repository:

➡️ [Open a private security advisory](https://github.com/bymaxone/nest-logger/security/advisories/new)

If you cannot use the GitHub form (e.g., you do not have an account), email **support@bymax.one** with `[security] @bymax-one/nest-logger` in the subject line.

### What to include

A useful report contains:

- A clear description of the vulnerability and its impact (CIA triad — confidentiality, integrity, availability)
- Step-by-step reproduction against the latest `0.x` release
- The affected subpath (`.` or `./shared`)
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

## Out of scope

These are not vulnerabilities in `@bymax-one/nest-logger` itself:

- Issues only reproducible in versions older than `0.1.0`
- Misconfigurations in the **consuming application** (e.g., disabling default redact paths via `shouldDisableDefaultRedact: true`, passing secrets as log metadata) unless they reproduce with the documented default configuration
- Issues in optional peer dependencies (`pino-pretty`, `@opentelemetry/api`) when the upstream maintainer has already accepted them or when the dependency is not exercised by the library
- Self-XSS, social engineering, denial of service via legitimate authenticated load
- Theoretical attacks without a practical demonstration

## Security best practices for consumers

The repository documentation covers deployment hardening:

- [docs/guidelines/PINO-REDACTION-GUIDELINES.md](docs/guidelines/PINO-REDACTION-GUIDELINES.md) — PII redaction paths, `fast-redact` wildcard semantics, extending defaults
- [docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md](docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md) — trace context injection, `isValidTraceId` invariants
- [docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md](docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md) — safe destination implementation patterns

Pin the package to an exact version in production, verify the publish provenance (`npm audit signatures`), and subscribe to the repository's security advisories so you receive notifications when a CVE is published.

## Acknowledgements

We are grateful to the security community and to every reporter who takes the time to investigate and disclose responsibly.
