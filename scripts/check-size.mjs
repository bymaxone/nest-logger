#!/usr/bin/env node
// Zero-dependency bundle-size gate. Measures every published subpath's ESM
// bundle (raw + brotli-compressed) and fails when any subpath exceeds the
// hard-coded budget below.
//
// Why zero deps: this is a logging library that ships `"dependencies": {}` on
// purpose. The CI/release runner must stay free of third-party tooling so a
// compromised devDep cannot tamper with the bundle before `pnpm publish`.
// `node:zlib`'s brotli matches what npm/CDN compression produces on the wire.

import { readFileSync, statSync } from 'node:fs'
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
  { name: 'server (NestJS module)', path: 'dist/server/index.mjs', brotli: 13.5 * 1024 },
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
  try {
    statSync(abs)
  } catch {
    console.error(`Missing build artifact: ${path} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  const raw = readFileSync(abs)
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
