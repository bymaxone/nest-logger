/**
 * @fileoverview Published-surface gate — proves the README, the CHANGELOG and the exported
 * types describe the package that is actually about to ship.
 * @layer scripts
 *
 * Every check here exists because its absence let a defect reach npm:
 *
 * - `1.0.3` shipped a README whose "Example App" link returned 404. Nothing read
 *   the links.
 * - `1.0.4` fixed an exported type that rejected the very snippet the README
 *   shows. `test:types` compiles `src` through a `paths` mapping, so it never
 *   sees what a consumer resolving through `exports` sees, and the consumer
 *   fixture happened to use a workaround form.
 * - A pull request deleted a `## [x.y.z]` heading while adding the next one,
 *   which silently turns the release notes into the generic fallback.
 *
 * Run after `pnpm build` — the snippets compile against `dist/`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

/** A throwaway consumer built by this script. Nothing outside it is touched, and
 * it is portable: the sibling libraries have no consumer fixture to borrow.
 *
 * The package is symlinked into its own `node_modules` so TypeScript resolves it
 * through the published `exports` map into `dist/` — exactly what a consumer
 * sees — while peers still resolve by walking up to the repository's own
 * `node_modules`. */
const GATE_DIR = join(ROOT, '.docs-gate')

/** The published type tests, compiled here against `dist/` as well. Empty when a
 * library has none — the check then covers only the README snippets. */
const TYPE_TESTS_GLOB = existsSync(join(ROOT, 'test', 'types')) ? '../test/types/**/*.ts' : '*.ts'

const failures = []
/** Record a failure without stopping, so one run reports every problem. */
const fail = (check, detail) => failures.push(`${check}: ${detail}`)

// ---------------------------------------------------------------------------
// 1. Every link in the README resolves.
// ---------------------------------------------------------------------------

/** Slug a Markdown heading the way GitHub does. Deliberately does NOT trim: the
 * space an emoji leaves behind becomes a leading hyphen, so `## 🚀 Quick Start`
 * is `#-quick-start` and not `#quick-start`. Trimming here would report every
 * correct emoji anchor in the file as broken. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s/g, '-')
}

async function checkLinks() {
  const anchors = new Set([...README.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => `#${slug(m[1])}`))
  // Only follow links a reader clicks. Badge images are excluded: a rate-limited
  // shields.io would fail the build for a reason that is not ours.
  const links = new Set([
    ...[...README.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
    ...[...README.matchAll(/<a\s+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
  ])
  const internal = new Set(
    [...README.matchAll(/\[[^\]]*\]\((#[^)\s]+)\)/g)].map((m) => m[1].toLowerCase())
  )

  for (const a of internal) {
    if (!anchors.has(a)) fail('links', `anchor ${a} matches no heading`)
  }

  const results = await Promise.all(
    [...links].map(async (url) => {
      // npmjs.com serves 403 to any datacenter IP, browser User-Agent included,
      // so asking it whether a package page exists measures Cloudflare rather
      // than the package. The registry is the authoritative source for the same
      // question and answers honestly — this redirects the check, it does not
      // suppress it: a package that truly does not exist still fails here.
      const probe = url.replace(
        /^https:\/\/www\.npmjs\.com\/package\/(.+)$/,
        (_, name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`
      )
      const headers = { 'user-agent': 'Mozilla/5.0 (compatible; bymax-docs-gate)' }
      try {
        // HEAD first; some hosts answer it with 405, so fall back to GET.
        let res = await fetch(probe, { method: 'HEAD', redirect: 'follow', headers })
        if (res.status === 405 || res.status === 403 || res.status === 429) {
          res = await fetch(probe, { method: 'GET', redirect: 'follow', headers })
        }
        if (res.ok) return null
        // A package page 404s until the first publish. Reported, never fatal:
        // failing here would block the very release that makes the link true.
        if (res.status === 404 && probe !== url) {
          console.log(`  note: ${url} is not live yet — expected until the first publish`)
          return null
        }
        return `${url} → HTTP ${res.status}`
      } catch (err) {
        // A transport error cannot tell "this link is dead" from "that host is
        // down right now". Reported, never fatal — this gate also guards
        // `prepublishOnly`, and someone else's outage must not block a release.
        console.log(
          `  note: ${url} could not be reached (${err instanceof Error ? err.message : String(err)})`
        )
        return null
      }
    })
  )
  for (const r of results) if (r) fail('links', r)
  console.log(`  links: ${links.size} external, ${internal.size} internal`)
}

// ---------------------------------------------------------------------------
// 2. The release notes for this version are extractable.
// ---------------------------------------------------------------------------

/** Mirrors the awk in `release.yml`: everything between this version's heading
 * and the next one. Kept deliberately identical — a check that reads the file
 * differently from the workflow proves nothing about the workflow. */
function releaseNotes(version) {
  const lines = CHANGELOG.split('\n')
  const start = lines.findIndex((l) => /^## \[/.test(l) && l.includes(`[${version}]`))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## \[/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

function checkChangelog() {
  const notes = releaseNotes(PKG.version)
  if (notes === null) {
    fail(
      'changelog',
      `no "## [${PKG.version}]" heading — the release would publish the generic fallback`
    )
    return
  }
  if (notes.length < 40) {
    fail(
      'changelog',
      `the "${PKG.version}" section is ${notes.length} characters — almost certainly an empty heading`
    )
  }
  const headings = [...CHANGELOG.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
  const documented = new Set(headings.filter((h) => /^\d+\.\d+\.\d+$/.test(h)))
  for (const v of documented) {
    const n = releaseNotes(v)
    if (!n || n.length < 40) fail('changelog', `the "${v}" section is empty or missing`)
  }

  // Checking only the versions the file happens to list cannot notice one that
  // is ABSENT — and a heading deleted while adding the next one is exactly how
  // the 1.0.3 entry was swallowed by 1.0.4. The tags are the outside source of
  // truth for what was released, so they are what the file is measured against.
  // `actions/checkout` clones with depth 1 and no tags, so `git tag --list`
  // returns an empty set with exit code 0 — the cross-check would pass by
  // finding nothing to check. Fetch them first, and if they still are not there
  // while the changelog claims released versions, say so instead of passing:
  // a silent no-op is the failure mode this whole gate exists to prevent.
  try {
    execFileSync('git', ['fetch', '--tags', '--quiet'], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    // No network or no remote — the local tags below are then all there is.
  }
  let released = []
  try {
    released = execFileSync('git', ['tag', '--list', 'v*.*.*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  } catch {
    fail('changelog', 'could not list git tags, so no version could be cross-checked')
    return
  }
  if (released.length === 0 && documented.size > 0) {
    fail(
      'changelog',
      `no v*.*.* tags are visible but the changelog documents ${documented.size} released version(s) — ` +
        'the cross-check cannot run. In CI, check out with `fetch-depth: 0` or `fetch-tags: true`.'
    )
    return
  }
  const missing = released.filter((v) => !documented.has(v))
  for (const v of missing) {
    fail(
      'changelog',
      `v${v} is tagged but has no "## [${v}]" section — its release notes would be the generic fallback`
    )
  }
  console.log(
    `  changelog: ${documented.size} sections, cross-checked against ${released.length} tag(s)`
  )
}

// ---------------------------------------------------------------------------
// A throwaway consumer, so everything below resolves through `exports` → dist/.
// ---------------------------------------------------------------------------

/** Create `.docs-gate/` with the package symlinked into its own `node_modules`.
 * `paths` is emptied: the repository tsconfig maps the package name to `./src`,
 * which is precisely the mapping that has to be out of the way here. */
function scaffoldConsumer() {
  rmSync(GATE_DIR, { recursive: true, force: true })
  const scope = join(GATE_DIR, 'node_modules', ...PKG.name.split('/').slice(0, -1))
  mkdirSync(scope, { recursive: true })
  symlinkSync(ROOT, join(GATE_DIR, 'node_modules', PKG.name), 'dir')
  writeFileSync(
    join(GATE_DIR, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: {
          noEmit: true,
          rootDir: '..',
          baseUrl: '.',
          paths: {},
          noUnusedLocals: false,
          // A README snippet may name a handler parameter it does not use; that is
          // prose, not an API defect.
          noUnusedParameters: false
        },
        include: ['*.ts', TYPE_TESTS_GLOB]
      },
      null,
      2
    )}\n`
  )
}

// ---------------------------------------------------------------------------
// 3. The README's own snippets compile against the built package.
// ---------------------------------------------------------------------------

function checkSnippets() {
  const blocks = [...README.matchAll(/^```(?:ts|typescript)\n([\s\S]*?)^```$/gm)].map((m) => m[1])
  // Only snippets that IMPORT the package: those are the ones making a claim
  // about the public API. Merely naming it in a comment is not a claim.
  const subjects = blocks.filter((b) => new RegExp(`from ['"]${PKG.name}`).test(b))
  if (subjects.length === 0) {
    fail('snippets', 'no README snippet imports the package — the gate would be vacuous')
    return
  }

  scaffoldConsumer()
  /** file name → its source, so a diagnostic can be traced back to the snippet. */
  const sources = new Map()
  subjects.forEach((code, i) => {
    const name = `snippet-${String(i + 1).padStart(2, '0')}.ts`
    sources.set(name, code)
    writeFileSync(join(GATE_DIR, name), code)
  })

  // A README snippet is written for a reader, not for a compiler: it may use a
  // variable introduced by the paragraph above it. Those diagnostics say nothing
  // about the published API, so they are counted and reported rather than
  // failing the build — and never dropped silently.
  const CONTEXT_ONLY = new Set([
    'TS2304',
    'TS2552',
    'TS7006',
    'TS18004',
    'TS2531',
    'TS2532',
    // Parse-level: a snippet that elides code with `…` or shows a bare `return`
    // is prose, not a program.
    'TS1108',
    'TS1109'
  ])
  /** `Property 'x' does not exist on type 'Y'` is an API defect when `Y` comes
   * from the package, and snippet noise when `Y` is a class the snippet declares
   * itself and abbreviates — a README example routinely writes `this.repo`
   * without spelling out the constructor that injects it. Decided by looking for
   * the declaration in the same snippet rather than by guessing from the code. */
  const isAbbreviatedLocalType = (line, sources) => {
    const m = /Property '[^']+' does not exist on type '([^']+)'/.exec(line)
    if (!m) return false
    const file = /^([^(]+)\(/.exec(line)?.[1]
    const own = sources.get(file?.split('/').pop() ?? '') ?? ''
    return new RegExp(`\\b(class|interface|type)\\s+${m[1]}\\b`).test(own)
  }
  /** An import of some OTHER package the fixture does not install — a documented
   * optional integration. Reported as uncovered, not as a failure. */
  const isForeignModule = (line) => /error TS2307/.test(line) && !line.includes(PKG.name)

  try {
    execFileSync('npx', ['tsc', '-p', GATE_DIR], { cwd: ROOT, stdio: 'pipe' })
    console.log(`  snippets: ${subjects.length} README snippets compile against dist/`)
  } catch (err) {
    const lines = `${err.stdout ?? ''}${err.stderr ?? ''}`
      .trim()
      .split('\n')
      .filter((l) => /error TS\d+/.test(l))
    const real = lines.filter(
      (l) =>
        !CONTEXT_ONLY.has((/error (TS\d+)/.exec(l) ?? [])[1]) &&
        !isForeignModule(l) &&
        !isAbbreviatedLocalType(l, sources)
    )
    const context = lines.length - real.length
    if (real.length > 0) {
      fail(
        'snippets',
        `${real.length} README snippet error(s) about the published API:\n${real.map((l) => `      ${l}`).join('\n')}`
      )
    }
    console.log(
      `  snippets: ${subjects.length} compiled against dist/` +
        (context > 0
          ? ` (${context} diagnostic(s) ignored: undeclared context or a peer the fixture does not install)`
          : '')
    )
  } finally {
    rmSync(GATE_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

console.log(`Published-surface gate — ${PKG.name}@${PKG.version}`)
await checkLinks()
checkChangelog()
checkSnippets()

if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} problem(s):\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n✔ The documentation and the exported types match the built package.')
