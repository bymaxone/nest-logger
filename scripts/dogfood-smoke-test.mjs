#!/usr/bin/env node
/**
 * Dogfood smoke test — validates the published package shape before tagging.
 *
 * It validates the TARBALL, the file that gets published, and never `dist/`:
 *   1. The tarball holds the build artifacts for both subpaths (ESM, CJS, .d.ts)
 *   2. ESM import of the unpacked tarball resolves all expected named exports
 *   3. CJS require of the unpacked tarball resolves all expected named exports
 *   4. The tarball lists only dist/ + meta files
 *   5. A minimal consumer in an OS temp dir installs the tarball (with `--ignore-scripts`) and
 *      resolves the package through its published `exports` map
 *
 * The tarball is `PACKAGE_TARBALL`, the copy the release workflow hands to its gates. Without it
 * (a local run) one is packed into a temp dir with `npm pack`.
 *
 * Exit codes:
 *   0 — all assertions pass
 *   1 — one or more assertions failed (details printed to stderr)
 *   2 — the tarball is missing or has no build artifacts
 *
 * Usage:
 *   pnpm build && node scripts/dogfood-smoke-test.mjs
 *   PACKAGE_TARBALL=/path/to/package.tgz node scripts/dogfood-smoke-test.mjs
 */

import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Temp dirs are created lazily, after the checks that can `process.exit(2)`, so an early exit leaks
// nothing; `cleanup` removes whatever was created.
let consumerDir
let workDir

/** Remove the temp dirs this run created. */
function cleanup() {
  for (const dir of [consumerDir, workDir]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

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

// ── 0. The tarball ──────────────────────────────────────────────────────────

/** The tarball to test: the copy the release workflow names, or one packed here for a local run. */
function resolveTarball() {
  const given = process.env['PACKAGE_TARBALL']
  if (given) {
    const abs = resolve(given)
    if (!existsSync(abs)) {
      console.error(`PACKAGE_TARBALL does not exist: ${abs}`)
      process.exit(2)
    }
    return abs
  }
  workDir = mkdtempSync(join(tmpdir(), 'dogfood-pack-'))
  execFileSync('npm', ['pack', '--pack-destination', workDir], { cwd: ROOT, stdio: 'pipe' })
  const packed = readdirSync(workDir).filter((f) => f.endsWith('.tgz'))
  if (packed.length !== 1) {
    console.error('npm pack must produce exactly one tarball.')
    process.exit(2)
  }
  return join(workDir, packed[0])
}

const TARBALL = resolveTarball()
workDir ??= mkdtempSync(join(tmpdir(), 'dogfood-unpack-'))
const UNPACKED = join(workDir, 'unpacked')
execFileSync('mkdir', ['-p', UNPACKED])
execFileSync('tar', ['-xzf', TARBALL, '-C', UNPACKED])
// The package's peer dependencies resolve from this repository's own node_modules, exactly as the
// dist/ of a checkout did, so the unpacked copy can be imported without an install.
const PKG = join(UNPACKED, 'package')
symlinkSync(join(ROOT, 'node_modules'), join(PKG, 'node_modules'))

// ── 1. Build artifact presence ──────────────────────────────────────────────

section('1. Build artifacts in the tarball')
for (const f of EXPECTED_DIST_FILES) {
  const abs = resolve(PKG, f)
  if (!existsSync(abs)) {
    console.error(`Missing build artifact in the tarball: ${f}`)
    cleanup()
    process.exit(2)
  }
  pass(f)
}

// ── 2. ESM named exports — server subpath ───────────────────────────────────

section('2. ESM named exports — server')
const serverEsm = await import(resolve(PKG, 'dist/server/index.mjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  if (name in serverEsm) {
    pass(`export ${name}`)
  } else {
    fail(`Missing export: ${name}`)
  }
}

// ── 3. ESM named exports — shared subpath ───────────────────────────────────

section('3. ESM named exports — shared')
const sharedEsm = await import(resolve(PKG, 'dist/shared/index.mjs'))
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
const serverCjs = req(resolve(PKG, 'dist/server/index.cjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  if (name in serverCjs) {
    pass(`cjs export ${name}`)
  } else {
    fail(`Missing CJS export: ${name}`)
  }
}

// ── 4b. CJS exports — shared subpath ────────────────────────────────────────

section('4b. CJS exports — shared')
const sharedCjs = req(resolve(PKG, 'dist/shared/index.cjs'))
for (const name of EXPECTED_SHARED_EXPORTS) {
  if (name in sharedCjs) {
    pass(`cjs export ${name}`)
  } else {
    fail(`Missing CJS export (shared): ${name}`)
  }
}

// ── 5. Tarball contents ──────────────────────────────────────────────────────

section('5. Tarball contents (tar -tzf)')
try {
  const listing = execFileSync('tar', ['-tzf', TARBALL], { encoding: 'utf8' })
  // Every entry of an npm tarball sits under `package/`; the check is on the path below it.
  const contentLines = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package/') && !line.endsWith('/'))
    .map((line) => line.slice('package/'.length))

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
} catch (err) {
  fail(`Listing the tarball failed: ${String(err.message)}`)
}

// ── 6. Consumer file: link smoke ─────────────────────────────────────────────

section('6. Consumer install of the tarball (minimal resolution check)')
try {
  // Scaffold a minimal consumer in a unique, unpredictable temp dir (mkdtemp
  // appends random chars) — avoids the symlink/race hazards of a fixed /tmp
  // path. Created here, not at module load, so early exits leak nothing.
  consumerDir = mkdtempSync(join(tmpdir(), 'dogfood-consumer-'))
  const consumerPkgJson = {
    name: 'dogfood-consumer',
    version: '0.0.1',
    type: 'module',
    dependencies: {
      '@bymax-one/nest-logger': `file:${TARBALL}`
    }
  }
  writeFileSync(resolve(consumerDir, 'package.json'), JSON.stringify(consumerPkgJson, null, 2))

  // `--ignore-scripts`: the install runs no script of the package or of what it pulls in.
  const installResult = spawnSync('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 60_000
  })
  if (installResult.status !== 0) {
    fail(`pnpm install in consumer failed: ${installResult.stderr}`)
  } else {
    pass('pnpm install of the tarball succeeded')

    // Verify both subpaths resolve from consumer node_modules
    const consumerServerPath = resolve(
      consumerDir,
      'node_modules/@bymax-one/nest-logger/dist/server/index.mjs'
    )
    const consumerSharedPath = resolve(
      consumerDir,
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

    // Import by PACKAGE SPECIFIER from the consumer's cwd (not an absolute
    // path) so this exercises the published `exports` map exactly as a real
    // consumer's `import '@bymax-one/nest-logger'` would resolve it.
    const specifierProbe = [
      "import('@bymax-one/nest-logger')",
      ".then((m) => { if (!('BymaxLoggerModule' in m)) process.exit(3) })",
      ".then(() => import('@bymax-one/nest-logger/shared'))",
      ".then((s) => { if (!('RESERVED_LOG_KEYS' in s)) process.exit(4) })",
      '.catch((e) => { console.error(e); process.exit(5) })'
    ].join('')
    const importResult = spawnSync('node', ['--input-type=module', '-e', specifierProbe], {
      cwd: consumerDir,
      encoding: 'utf8',
      timeout: 30_000
    })
    if (importResult.status === 0) {
      pass('package specifiers resolve via exports map from consumer cwd')
    } else {
      fail(
        `Consumer-side specifier import failed (code ${importResult.status}): ${importResult.stderr}`
      )
    }
  }
} catch (err) {
  fail(`Consumer scaffolding failed: ${String(err.message)}`)
} finally {
  cleanup()
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
