#!/usr/bin/env node
/**
 * Dogfood smoke test — validates the published package shape before tagging.
 *
 * What this script validates:
 *   1. Build artifacts exist for both subpaths (ESM, CJS, .d.ts)
 *   2. ESM import resolves all expected named exports
 *   3. CJS require resolves all expected named exports
 *   4. Tarball contents (via npm pack --dry-run output) contain only dist/ + meta files
 *   5. Scaffolds a minimal consumer in /tmp/dogfood-consumer, installs via file:
 *      link, and verifies the module can be imported from the consumer side
 *
 * Exit codes:
 *   0 — all assertions pass
 *   1 — one or more assertions failed (details printed to stderr)
 *   2 — build artifacts missing (run `pnpm build` first)
 *
 * Usage:
 *   pnpm build && node scripts/dogfood-smoke-test.mjs
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync, spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Unique, unpredictable temp dir (mkdtemp appends random chars) — avoids the
// symlink/race hazards of writing to a fixed, world-known path under /tmp.
const CONSUMER_DIR = mkdtempSync(join(tmpdir(), 'dogfood-consumer-'))

const EXPECTED_DIST_FILES = [
  'dist/server/index.mjs',
  'dist/server/index.cjs',
  'dist/server/index.d.ts',
  'dist/server/index.d.cts',
  'dist/shared/index.mjs',
  'dist/shared/index.cjs',
  'dist/shared/index.d.ts',
  'dist/shared/index.d.cts'
]

const EXPECTED_SERVER_EXPORTS = [
  'BymaxLoggerModule',
  'PinoLoggerService',
  'DefaultStdoutDestination',
  'PrettyDevDestination',
  'LogContextService',
  // DestinationRegistry is intentionally NOT public — it is an internal service.
  // Consumers only interact with it indirectly via BymaxLoggerModuleOptions.destinations.
  'HttpLoggingInterceptor', // renamed from LoggingInterceptor to align with NestJS naming
  'HttpExceptionFilter',
  'RequestIdMiddleware',
  'applyRequestIdMiddleware',
  'InjectLogger',
  'LogContext', // decorator (not the LogContext bag interface — that is internal)
  'LOG_CONTEXT_METADATA_KEY',
  'LogPerformance',
  'LOGGER_OPTIONS_TOKEN',
  'LOGGER_PINO_INSTANCE_TOKEN',
  'LOGGER_DESTINATIONS_TOKEN',
  'LOG_CONTEXT_TOKEN',
  'DEFAULT_REDACT_PATHS',
  'LOG_KEYS_CONVENTION_REGEX',
  'RESERVED_LOG_KEYS'
]

const EXPECTED_SHARED_EXPORTS = ['LOG_KEYS_CONVENTION_REGEX', 'RESERVED_LOG_KEYS']

const ALLOWED_TARBALL_PATHS = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/']

let failures = 0

function fail(msg) {
  console.error(`  FAIL: ${msg}`)
  failures++
}

function pass(msg) {
  console.log(`  PASS: ${msg}`)
}

function section(title) {
  console.log(`\n── ${title}`)
}

// ── 1. Build artifact presence ──────────────────────────────────────────────

section('1. Build artifacts')
for (const f of EXPECTED_DIST_FILES) {
  const abs = resolve(ROOT, f)
  if (!existsSync(abs)) {
    console.error(`Missing build artifact: ${f} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  pass(f)
}

// ── 2. ESM named exports — server subpath ───────────────────────────────────

section('2. ESM named exports — server')
const serverEsm = await import(resolve(ROOT, 'dist/server/index.mjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  if (name in serverEsm) {
    pass(`export ${name}`)
  } else {
    fail(`Missing export: ${name}`)
  }
}

// ── 3. ESM named exports — shared subpath ───────────────────────────────────

section('3. ESM named exports — shared')
const sharedEsm = await import(resolve(ROOT, 'dist/shared/index.mjs'))
for (const name of EXPECTED_SHARED_EXPORTS) {
  if (name in sharedEsm) {
    pass(`export ${name}`)
  } else {
    fail(`Missing export: ${name}`)
  }
}

// ── 4. CJS exports ──────────────────────────────────────────────────────────

section('4. CJS exports — server')
const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
const serverCjs = req(resolve(ROOT, 'dist/server/index.cjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  if (name in serverCjs) {
    pass(`cjs export ${name}`)
  } else {
    fail(`Missing CJS export: ${name}`)
  }
}

// ── 4b. CJS exports — shared subpath ────────────────────────────────────────

section('4b. CJS exports — shared')
const sharedCjs = req(resolve(ROOT, 'dist/shared/index.cjs'))
for (const name of EXPECTED_SHARED_EXPORTS) {
  if (name in sharedCjs) {
    pass(`cjs export ${name}`)
  } else {
    fail(`Missing CJS export (shared): ${name}`)
  }
}

// ── 5. Tarball contents ──────────────────────────────────────────────────────

section('5. Tarball contents (npm pack --dry-run)')
try {
  const packOut = execSync('npm pack --dry-run 2>&1', { cwd: ROOT, encoding: 'utf8' })
  // extract the paths listed under "Tarball Contents"
  // Lines with file sizes look like: "npm notice  2.4kB  CHANGELOG.md"
  // Match B, kB, KB, MB etc. Exclude metadata lines (shasum, integrity, total-files).
  const SIZE_RE = /\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+\S+/
  const SIZE_STRIP_RE = /.*npm notice\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+/
  const contentLines = packOut
    .split('\n')
    .filter((l) => l.includes('npm notice') && SIZE_RE.test(l))
    .map((l) => l.replace(SIZE_STRIP_RE, '').trim())
    .filter((l) => Boolean(l) && !l.startsWith('npm notice') && !/^sha\d+:/i.test(l))

  const unexpectedFiles = contentLines.filter(
    (f) => !ALLOWED_TARBALL_PATHS.some((prefix) => f === prefix || f.startsWith(prefix))
  )
  if (unexpectedFiles.length === 0) {
    pass(`Tarball contains only dist/ + meta files (${contentLines.length} entries)`)
  } else {
    for (const f of unexpectedFiles) {
      fail(`Unexpected file in tarball: ${f}`)
    }
  }
  // Cleanup the .tgz generated by npm pack
  try {
    execSync('rm -f bymax-one-nest-logger-*.tgz', { cwd: ROOT })
  } catch {
    // ignore cleanup errors
  }
} catch (err) {
  fail(`npm pack --dry-run failed: ${String(err.message)}`)
}

// ── 6. Consumer file: link smoke ─────────────────────────────────────────────

section('6. Consumer file: link smoke (minimal resolution check)')
try {
  // Scaffold a minimal consumer (CONSUMER_DIR already exists via mkdtempSync)
  const consumerPkgJson = {
    name: 'dogfood-consumer',
    version: '0.0.1',
    type: 'module',
    dependencies: {
      '@bymax-one/nest-logger': `file:${ROOT}`
    }
  }
  writeFileSync(resolve(CONSUMER_DIR, 'package.json'), JSON.stringify(consumerPkgJson, null, 2))

  // Install via pnpm (resolves the file: link)
  const installResult = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: CONSUMER_DIR,
    encoding: 'utf8',
    timeout: 60_000
  })
  if (installResult.status !== 0) {
    fail(`pnpm install in consumer failed: ${installResult.stderr}`)
  } else {
    pass('pnpm install with file: link succeeded')

    // Verify both subpaths resolve from consumer node_modules
    const consumerServerPath = resolve(
      CONSUMER_DIR,
      'node_modules/@bymax-one/nest-logger/dist/server/index.mjs'
    )
    const consumerSharedPath = resolve(
      CONSUMER_DIR,
      'node_modules/@bymax-one/nest-logger/dist/shared/index.mjs'
    )

    if (existsSync(consumerServerPath)) {
      pass('server subpath resolves from consumer node_modules')
    } else {
      fail('server subpath missing from consumer node_modules')
    }

    if (existsSync(consumerSharedPath)) {
      pass('shared subpath resolves from consumer node_modules')
    } else {
      fail('shared subpath missing from consumer node_modules')
    }

    // Import from consumer side to prove the file: link is not a local path
    try {
      const serverFromConsumer = await import(consumerServerPath)
      if ('BymaxLoggerModule' in serverFromConsumer) {
        pass('BymaxLoggerModule importable from consumer-side resolution')
      } else {
        fail('BymaxLoggerModule not exported from consumer-side resolution')
      }
    } catch (err) {
      fail(`Consumer-side import failed: ${String(err.message)}`)
    }
  }
} catch (err) {
  fail(`Consumer scaffolding failed: ${String(err.message)}`)
} finally {
  // Cleanup
  try {
    rmSync(CONSUMER_DIR, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log('')
if (failures === 0) {
  console.log('✓ All dogfood smoke assertions passed.')
  process.exit(0)
} else {
  console.error(`✗ ${failures} assertion(s) failed.`)
  process.exit(1)
}
