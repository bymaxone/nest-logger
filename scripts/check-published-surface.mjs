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

/** The repository's pinned compiler. */
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const failures = []
/** Record a failure without stopping, so one run reports every problem. */
const fail = (check, detail) => failures.push(`${check}: ${detail}`)

// ---------------------------------------------------------------------------
// 1. Every link in the README points somewhere real. A bad HTTP status fails the
//    gate; a link the machine could not reach at all is reported as a note, since
//    an offline runner is not a defect in the documentation.
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

/** README with fenced blocks removed. A `# Using pnpm` inside a ```bash fence is
 * a shell comment, not a heading, and letting it into the anchor set makes a
 * broken anchor pass. */
const README_PROSE = README.replace(/^```[\s\S]*?^```$/gm, '')

/** Hosts a documentation link must never point at. This check runs on
 * `pull_request`, so without it a fork could put `http://169.254.169.254/…` or a
 * loopback address in the README and have the CI runner probe it — the runner
 * reaching an endpoint the author cannot reach themselves. Rejected before the
 * request, not after, and reported as a finding rather than skipped: a published
 * README has no business linking to a private address either way.
 *
 * Every bare IP literal is refused, not just the private ranges. Enumerating
 * ranges means enumerating them again for IPv6, and again for whatever notation
 * is missed next; a documentation link points at a hostname, so the whole class
 * can go. The private ranges keep their own message because naming the range is
 * the more useful diagnosis when a link does hit one. */
function unroutableReason(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return 'is not a valid URL'
  }
  if (u.protocol !== 'https:') return `uses ${u.protocol.replace(':', '')}, not https`
  // A fully-qualified name keeps its trailing dot through the URL parser, and
  // `localhost.` resolves exactly like `localhost` — so the dot has to go
  // before the name is compared, or it is a one-character bypass.
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    return 'is a loopback name'
  }
  // A URL parser brackets every IPv6 literal, so the brackets are the test —
  // no need to recognise the address notation itself.
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1)
    if (v6 === '::1') return 'is a loopback address'
    if (/^f[cd]/.test(v6)) return 'is a unique-local address'
    if (/^fe[89ab]/.test(v6)) return 'is a link-local address'
    return 'is an IPv6 literal, not a hostname'
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return 'is a loopback address'
    if (h === '0.0.0.0') return 'is the unspecified address'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return 'is a private address'
    }
    if (a === 169 && b === 254) return 'is a link-local address (cloud metadata range)'
    return 'is an IPv4 literal, not a hostname'
  }
  return null
}

async function checkLinks() {
  const anchors = new Set(
    [...README_PROSE.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => `#${slug(m[1])}`)
  )
  // Only follow links a reader clicks. A badge is `[![alt](image)](target)`, and
  // a naive link regex captures the IMAGE — probing shields.io on every run and
  // failing the build when it rate-limits, for a reason that is not ours. The
  // image is stripped first so only the target remains.
  const clickable = README.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  const links = new Set([
    ...[...clickable.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
    ...[...clickable.matchAll(/<a\s+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
  ])
  // Both spellings: the section links are Markdown, but the header navigation is
  // raw HTML. Collecting only the first left this README's nav bar unchecked.
  const internal = new Set([
    ...[...README.matchAll(/\[[^\]]*\]\((#[^)\s]+)\)/g)].map((m) => m[1].toLowerCase()),
    ...[...README.matchAll(/<a\s+href="(#[^"]+)"/g)].map((m) => m[1].toLowerCase())
  ])

  for (const a of internal) {
    if (!anchors.has(a)) fail('links', `anchor ${a} matches no heading`)
  }

  const results = await Promise.all(
    [...links].map(async (url) => {
      const unroutable = unroutableReason(url)
      if (unroutable) return `${url} → ${unroutable}`

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
        // Bounded per request: this gate runs inside `prepublishOnly`, and one
        // hung host must not stall a publish until the job timeout.
        const opts = { redirect: 'follow', headers, signal: AbortSignal.timeout(10_000) }
        let res = await fetch(probe, { method: 'HEAD', ...opts })
        if (res.status === 405 || res.status === 403 || res.status === 429) {
          res = await fetch(probe, { method: 'GET', ...opts })
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
  // `.replace(/\s+$/, '')` and not `.trim()`: the awk prints each line verbatim
  // and only command substitution drops the trailing newline. Trimming the left
  // side too would report a different body from the one the release publishes.
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').replace(/\s+$/, '')
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

  // Every version heading is reference-link syntax, so it renders as plain text
  // unless a `[x.y.z]: url` definition exists. Three headings had one and three
  // did not, which is invisible until someone reads the rendered file.
  const defined = new Set([...CHANGELOG.matchAll(/^\[(\d+\.\d+\.\d+)\]: /gm)].map((m) => m[1]))
  for (const v of documented) {
    if (!defined.has(v)) {
      fail(
        'changelog',
        `the "${v}" heading is a reference link with no \`[${v}]: …\` definition, so it renders as plain text`
      )
    }
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
    // Bounded: an unreachable remote must not hang a publish. On timeout the
    // local tags below are all there is, and the shallow guard still fires.
    execFileSync('git', ['fetch', '--tags', '--quiet'], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 20_000
    })
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
  // No tags is the normal state of a package that has never been released, so
  // the absence alone proves nothing. What must not pass quietly is a SHALLOW
  // checkout, where the tags exist but were not fetched — there the check would
  // find nothing and report success.
  let shallow = false
  try {
    shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8'
      }).trim() === 'true'
  } catch {
    // Not a git repository at all; the tag list below is simply empty.
  }
  if (released.length === 0 && shallow) {
    fail(
      'changelog',
      'the checkout is shallow and carries no tags, so the cross-check cannot run. ' +
        'In CI, check out with `fetch-depth: 0` or `fetch-tags: true`.'
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
  // 'junction' rather than 'dir': a directory symlink needs elevation or Developer
  // Mode on Windows, where a junction does not. Node ignores the type on POSIX.
  symlinkSync(ROOT, join(GATE_DIR, 'node_modules', PKG.name), 'junction')
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
    // `tsc` emits backslashes on Windows, so the basename is taken on either.
    const own = sources.get(file?.split(/[\\/]/).pop() ?? '') ?? ''
    return new RegExp(`\\b(class|interface|type)\\s+${m[1]}\\b`).test(own)
  }
  /** An import of some OTHER package the fixture does not install — a documented
   * optional integration. Reported as uncovered, not as a failure. */
  const isForeignModule = (line) => /error TS2307/.test(line) && !line.includes(PKG.name)

  try {
    // The repository's own TypeScript, not `npx tsc`: npx may fetch a different
    // version, and a gate that compiles against a compiler the project does not
    // use is measuring the wrong thing.
    execFileSync(process.execPath, [TSC, '-p', GATE_DIR], { cwd: ROOT, stdio: 'pipe' })
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
