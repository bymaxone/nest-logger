#!/usr/bin/env node
// Zero-dependency bundle-size gate. Measures every published subpath's ESM
// bundle (raw + brotli-compressed) and fails when any subpath exceeds the
// hard-coded budget below.
//
// Why zero deps: this is a logging library that ships `"dependencies": {}` on
// purpose. The CI/release runner must stay free of third-party tooling so a
// compromised devDep cannot tamper with the bundle before `pnpm publish`.
// `node:zlib`'s brotli matches what npm/CDN compression produces on the wire.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Budgets are in bytes (KiB units, `n * 1024`, matching the table's ÷1024
// display) measured against the brotli'd .mjs bundle — what a consumer's
// bundler/CDN ships. Brotli, not gzip, to match real wire compression.
//
// Bymax bundle-size convention (canonical: Obsidian → 03 - Resources/NestJS/
// Bymax-Conventions.md → "Bundle-size budgets"):
//   1. The .mjs ships UNMINIFIED with JSDoc (tsup `minify: false`) on purpose —
//      readable stack traces / source inside a consumer's node_modules outweigh
//      a few KB on a backend lib that never reaches a browser. We do NOT minify
//      a lib just to satisfy a size budget.
//   2. The budget is CALIBRATED to the real built artifact + MODEST headroom:
//      enough to absorb normal inter-release growth, tight enough to catch
//      accidental bloat (e.g. a peer dep leaking into the bundle). It is a
//      bloat tripwire, NOT a hard design ceiling — when real growth is
//      legitimate, raise it (and say why here); when the artifact shrinks,
//      tighten it. Avoid >2x headroom: it silently lets bloat through.
//
// Calibration history (newest first):
//   - 2026-08-29 — server: 26.51 KiB real -> 27.8 KiB budget (~4.9% headroom).
//     RE-DERIVED from the artifact, per the standing rule. The growth is
//     `1.4.0`'s pre-routing access log: `applyAccessLog(app)`, the
//     `HttpAccessLogMiddleware` export, `LogContextService.runMerged`, and the
//     idempotency the first two require (`RequestIdMiddleware` enriches an open
//     scope instead of nesting one; the access log stands down on an
//     already-claimed request).
//     Checked before raising it, because the honest question is whether the
//     growth is bloat: it is not comment weight. The file-level docblock and the
//     inline `//` comments do NOT survive the build — grepping the bundle for
//     them returns zero — so trimming prose to fit was measured and moved the
//     artifact by 0.00 KiB. What ships is executable code plus the JSDoc on the
//     declarations, which is the deliberate policy in rule 1 above.
//     The gate was at 0.05 KiB of headroom before this change, which is why it
//     fired on the first real feature to land after it. That is the tripwire
//     working, not a budget being nudged: the number is recomputed from the
//     built artifact, not moved far enough to make the failure stop.
//   - 2026-08-16 — server: 24.19 KiB real -> 25.4 KiB budget (~5% headroom).
//     RE-DERIVED again, per the rule the entry below set: when the artifact moves
//     past the budget, recompute from the artifact rather than nudge the number.
//     The growth is the readiness contract earning its correctness across four
//     review rounds — level-aware delivery, identity so a destination is not its
//     own witness, write-failure tracking, and an in-flight counter so a pending
//     async write reads as unproven rather than as silent success. Each addition
//     closed a path that could DISCARD a boot entry nobody else held.
//     The policy those facts serve is the maintainer's, stated plainly: losing a
//     log line is unacceptable, duplicating one is the accepted cost. So the hook
//     discards only what is PROVEN delivered and emits everything else — which is
//     why the correctness of that single fact is worth this much code.
//   - 2026-08-15 — server: 22.80 KiB real -> 23.9 KiB budget (~4.8% headroom).
//     RE-DERIVED from the artifact, not nudged past it, and that distinction is
//     the entry. The two previous raises each moved the number just far enough to
//     admit the change in hand, which is how a tripwire turns into a rubber stamp:
//     by this release the gate had 0.01 KiB of headroom, so it no longer answered
//     "is this bloat?" — it answered "did anything at all change?".
//     Worse, it started deciding documentation. The 1.2.8 work exceeded 22.5, and
//     the first response was to cut three JSDoc blocks explaining why a drain had
//     moved between lifecycle hooks — trimming prose to satisfy a number, on a
//     library whose stated convention (rule 1 above) is that the bundle ships
//     unminified WITH its JSDoc because a readable trace inside a consumer's
//     node_modules outweighs a few KB. The trim was reverted and the text is back.
//     The growth itself is real surface for a measured defect: an optional
//     `ILogDestination.onRegistryReady`, the registry loop that calls it, a
//     `hasHealthySink` accessor, and the docs for all three. A pretty destination
//     registered beside another sink printed every buffered boot entry twice,
//     because it drained its buffer without being able to know that the fan-out
//     had already delivered those entries elsewhere.
//     Set from the real artifact plus ~5%, the same way the 2026-08-12 entry was.
//     If the next change needs this moved again, re-derive it again rather than
//     adding a fourth nudge — and if the artifact ever shrinks, tighten it.
//   - 2026-08-15 — server: 21.66 KiB real -> 22.5 KiB budget (~3.9% headroom).
//     SECOND raise in two days, which is worth naming rather than burying: the
//     tripwire has now moved twice for the same body of work, and a budget that
//     follows the code is not a budget. It is raised anyway because the +0.16 KiB
//     is a crash-prevention fix rather than feature surface — `safe-stdio.util.ts`,
//     which installs the swallow-EPIPE handler that the `try/catch` in three
//     already-shipped paths only CLAIMED to provide. Measured: a closed pipe gave
//     no synchronous throw, an asynchronous UNCAUGHT:EPIPE, and exit 42. Refusing
//     the 0.16 KiB would mean keeping a documented guarantee that does not exist.
//     Trimming was tried first and recovered EXACTLY ZERO: this module's JSDoc is
//     absent from the built `.mjs` (0 occurrences of its header text), so unlike
//     the 2026-08-14 entry the cost here is entirely code. Worth remembering the
//     next time comments are suspected — tsup does not preserve every comment, and
//     the assumption that it does is itself measurable.
//     If the next change also needs a raise, the right move is to question the
//     growth rather than the number.
//   - 2026-08-14 — server: 20.59 KiB real -> 21.5 KiB budget (~4.4% headroom).
//     This RE-TIGHTENS the deliberately-wide 18% headroom the entry below asked
//     to have re-tightened "once that lands and the artifact stops moving": the
//     artifact had already drifted 16.93 -> 19.13 KiB on `main` without the
//     budget moving, so the gate was down to 4.4% before this change even
//     started.
//     The +1.46 KiB over `main` is the destination init-failure fix: a shared
//     `DestinationHealth` record, the fan-out check that keeps a failed sink from
//     receiving writes, the stdout last-resort rescue, and one extracted stderr
//     reporter (which REPLACED a duplicated block, so it is close to neutral).
//     It buys back a defect where a single sink failing `onInit` left the whole
//     application writing nothing to either stream, silently — measured, not
//     argued. Per rule 1 the answer was NOT to minify; per rule 2 this is real
//     growth, so the tripwire moves with it.
//     Trimming the new comments first was tried and recovered 0.07 KiB, which is
//     the honest evidence that the cost here is code rather than prose.
//   - 2026-08-13 — server: 16.93 KiB real -> 20.0 KiB budget (~18% headroom).
//     Raised deliberately and with more headroom than the usual ~5%, by the
//     maintainer's decision. The 16.0 budget had 0.03 KiB left and the HTTP
//     observability fix took the artifact to 16.93 KiB, so the gate was blocking
//     a security fix rather than catching bloat: guard rejections (401/403/429)
//     and unmatched routes produced no log line at all, because logging was
//     interceptor-based and NestJS runs guards first. Closing that needs a
//     middleware, a `close` listener and URL sanitisation — none of which fit in
//     30 bytes. Per rule 1 the answer was NOT to minify.
//     The ~18% headroom is wider than the usual ~5% ON PURPOSE, to absorb the
//     follow-up already scoped (semconv `error.type` for delivery failure), and
//     it should be re-tightened to real + ~5% once that lands and the artifact
//     stops moving. A budget left this loose stops being a tripwire.
//   - 2026-08-12 — server: 15.29 KiB real -> 16.0 KiB budget (~4.6% headroom).
//     The +0.79 KiB over the prior 13.5 KiB is the P0 audit remediation, and it
//     is feature surface rather than bloat: the name-based redaction engine
//     (`redact-by-name.util.ts` — a recursive copy-on-write walk replacing 108
//     wildcard `fast-redact` paths, which made the shipped path ~50x faster and
//     removed the four-level nesting ceiling), the `redactStrategy` escape hatch
//     plumbed through options/validation/factory, the `assignIfDefined` guard
//     that stopped `undefined` reserved fields clobbering AsyncLocalStorage
//     context, and the two reserved keys that are now actually emitted
//     (`LOGGER_BOOTSTRAP_WARNING`, `LOGGER_SHUTDOWN_OK`). Per rule 1 above the
//     bundle ships unminified with its JSDoc, and that JSDoc is a meaningful
//     share of the delta — the new util documents the measurements behind the
//     engine change at the seam where a future reader would otherwise undo it.
//     Walked across the reviews of that same change: 15.0 at first; 15.5 once
//     the code review added `withoutOwnedKeys` (restoring the reserved-field
//     invariant), split `walkArray` out to stay inside the nesting limit, and
//     made `RESERVED_LOG_KEYS_NOT_EMITTED` public; back to 15.25 when dropping
//     four redundant Stryker suppressions returned 0.28 KiB. Then to 16.25 for
//     the PR-review remediation, which closed three verified leaks the first
//     design had: child bindings (redacted in `PinoLoggerService.child()`,
//     because Pino pre-serializes them past every formatter), `Error` values
//     under a key with no serializer (cloned through prototype + descriptors so
//     they stay Errors), and secrets synthesized by `toJSON()` (its output is
//     now walked). Plus a `mixinMergeStrategy` so a hostile getter cannot crash
//     the log call ahead of the fail-closed envelope. Per rule 2, retighten when
//     the artifact shrinks — this one grew, and every kilobyte of it is a leak
//     that used to be open.
//   - 2026-06-16 — server: 12.84 KiB real -> 13.5 KiB budget (~5% headroom).
//     The +0.34 KiB over the prior 12.5 KiB is legitimate audit-hardening
//     surface — fail-soft destination containment, query-string stripping in the
//     exception filter, AggregateError width capping, the request-id generation
//     toggle, and the JSDoc that ships unminified alongside it — not bloat.
//   - 2026-05-30 — server: 12.05 KiB real -> 12.5 KiB budget (~4% headroom).
//     The +0.3 KiB over the original 12 KiB is legitimate feature surface
//     (pretty / registry / multistream / truncation / child-logger / async-HTTP),
//     not bloat.
//   - 2026-05-30 — shared: 0.34 KiB real -> 1.0 KiB budget (was 3.5 KiB — 10x
//     headroom defeats bloat detection; 1.0 KiB still absorbs years of
//     constant/type growth while catching a real regression).
const BUDGETS = [
  { name: 'server (NestJS module)', path: 'dist/server/index.mjs', brotli: 27.8 * 1024 },
  { name: 'shared (types + constants)', path: 'dist/shared/index.mjs', brotli: 1.0 * 1024 }
]

const fmt = (n) => `${(n / 1024).toFixed(2)} kB`

const BROTLI_OPTS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY }
}

let failed = 0
const rows = []

for (const { name, path, brotli: limit } of BUDGETS) {
  const abs = resolve(ROOT, path)
  // Read straight away rather than testing for the file first. A `statSync`
  // followed by `readFileSync` states a fact about the past: the file can be
  // gone, replaced, or truncated between the two calls. `readFileSync` already
  // fails when the artifact is missing, so one call reports the same thing
  // without the window.
  let raw
  try {
    raw = readFileSync(abs)
  } catch (error) {
    // Only a missing file earns the friendly message. A permission error or a
    // directory where a file belongs is a different problem, and reporting it as
    // "run pnpm build" sends the reader to the wrong place — rethrow so the real
    // code and stack reach the log.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    console.error(`Missing build artifact: ${path} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  const compressed = brotliCompressSync(raw, BROTLI_OPTS).length
  const ok = compressed <= limit
  if (!ok) failed += 1
  rows.push({
    name,
    raw: raw.length,
    brotli: compressed,
    limit,
    delta: compressed - limit,
    ok
  })
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('')
console.log(
  `  ${pad('Subpath', 38)}${padL('Raw', 12)}${padL('Brotli', 12)}${padL('Budget', 12)}  Status`
)
console.log(`  ${'-'.repeat(38)}${'-'.repeat(12)}${'-'.repeat(12)}${'-'.repeat(12)}  ------`)
for (const r of rows) {
  const status = r.ok ? 'PASS' : `FAIL +${fmt(r.delta)}`
  console.log(
    `  ${pad(r.name, 38)}${padL(fmt(r.raw), 12)}${padL(fmt(r.brotli), 12)}${padL(fmt(r.limit), 12)}  ${status}`
  )
}
console.log('')

if (failed > 0) {
  console.error(`${failed} subpath(s) exceeded the brotli budget.`)
  process.exit(1)
}
