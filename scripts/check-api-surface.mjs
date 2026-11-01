/**
 * @fileoverview Public-declaration gate — proves a PATCH release changes no public
 * declaration against the previous published version.
 * @layer scripts
 *
 * "Nothing in index.ts changed" is a claim read by eye, and it is the claim that lets a
 * new public method ship as a patch. This script makes it a measurement: it compares the
 * declaration files under `dist/` (`.d.ts` and `.d.cts`) with the same files of the previous published
 * version, after both are normalized, and fails when a patch differs.
 *
 * Normalization is the TypeScript printer with comments removed, so whitespace and JSDoc
 * never count, while the triple-slash reference directives (which decide what the file
 * type-checks against) and every member, signature, modifier and the order of declarations,
 * members and overloads does. A bundler may spell the same exports as `export { A, type B }` or
 * as `export { A }; export type { B }`; both export the same names, so both must normalize
 * identically. The lists are flattened to one record per specifier (type-only flag, local name,
 * exported name), sorted and printed once, so the exported names, their aliases and their
 * type-only-ness still count.
 *
 * A change of major or minor is allowed through: the differences are printed as
 * information and the exit code stays 0. There is deliberately no override flag. A failing
 * patch is resolved by changing the code or the version, never by switching the check off.
 *
 * Necessary, not sufficient: declarations carry no behaviour and no default values, so a
 * pass here proves the type surface is unchanged and nothing else about the release.
 *
 * Usage:
 *   node scripts/check-api-surface.mjs                   previous version from the registry
 *   node scripts/check-api-surface.mjs --against <path>  a directory holding `dist/`, or a
 *                                                        package tarball (offline)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const DECLARATION_FILE_RE = /\.d\.c?ts$/
const STABLE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Prints one declaration file in a form that ignores comments and formatting.
 *
 * @param {string} text - Contents of a `.d.ts` or `.d.cts` file.
 * @returns {string} Normalized text, ending with one canonical `exports:` line.
 */
export function normalizeDeclarations(text) {
  const source = ts.createSourceFile(
    'input.d.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const printer = ts.createPrinter({ removeComments: true })
  const specifiers = []
  const kept = []
  for (const statement of source.statements) {
    if (isLocalNamedExport(statement)) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text
        const typeOnly = statement.isTypeOnly || element.isTypeOnly
        // One JSON record per specifier, so no name, however it is spelled, can run into the
        // next record or into a keyword the way a space- or comma-joined string could.
        specifiers.push(JSON.stringify([typeOnly, local, element.name.text]))
      }
    } else {
      kept.push(printer.printNode(ts.EmitHint.Unspecified, statement, source))
    }
  }
  const directives = referenceDirectives(text)
  // Flattening the export lists can leave nothing behind, and `export {}` is what makes a file
  // a module instead of a script whose declarations are global, so that status is kept.
  const kind = ts.isExternalModule(source) ? 'module' : 'script'
  return `${directives.join('\n')}\n${kind}\n${kept.join('\n')}\nexports:\n${specifiers.sort().join('\n')}\n`
}

/** `/// <tag name="value" … />`: the tag, then the attributes with either quote style. */
const DIRECTIVE_RE = /^\/\/\/\s*<\s*([\w-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>\s*$/
const ATTRIBUTE_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * The triple-slash directives at the top of a file, one normalized line each, in source order.
 * They are comments to the printer yet they decide which ambient declarations the file
 * type-checks against, and the order of the files they pull in can decide how declarations
 * merge. Every `/// <…>` line counts, whatever its kind or attributes (`path`, `types`, `lib`,
 * `no-default-lib`, `amd-module`, `amd-dependency`, `resolution-mode`, `preserve`), so adding,
 * removing, reordering or changing one differs. Only the spacing and the quote style around
 * the attributes are normalized; an attribute's value is kept exactly as written, and a
 * directive that does not parse is kept verbatim.
 */
function referenceDirectives(text) {
  return (ts.getLeadingCommentRanges(text, 0) ?? [])
    .map((range) => text.slice(range.pos, range.end))
    .filter((comment) => /^\/\/\/\s*</.test(comment))
    .map(normalizeDirective)
}

/** One directive as `/// <tag name="value" … />`, with each value JSON-quoted and untouched. */
function normalizeDirective(comment) {
  const match = DIRECTIVE_RE.exec(comment)
  if (match === null) return comment.trim()
  const attributes = [...match[2].matchAll(ATTRIBUTE_RE)].map(
    (attribute) => `${attribute[1]}=${JSON.stringify(attribute[2] ?? attribute[3])}`
  )
  return `/// <${[match[1], ...attributes].join(' ')} />`
}

/** A top-level `export { … }` that re-exports local names, with no `from`. */
function isLocalNamedExport(statement) {
  return (
    ts.isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause)
  )
}

/**
 * Classifies the bump from `previous` to `current`.
 *
 * @param {string} previous - Previous published version, `x.y.z`.
 * @param {string} current - Version being released, `x.y.z`.
 * @returns {'major' | 'minor' | 'patch'} `patch` only when major and minor are unchanged.
 */
export function classifyBump(previous, current) {
  const [prevMajor, prevMinor] = parseVersion(previous)
  const [curMajor, curMinor] = parseVersion(current)
  if (curMajor !== prevMajor) return 'major'
  if (curMinor !== prevMinor) return 'minor'
  return 'patch'
}

/** @returns {[number, number, number]} The numeric parts of a stable `x.y.z` version. */
function parseVersion(version) {
  const match = STABLE_VERSION_RE.exec(version)
  if (match === null) throw new Error(`"${version}" is not a stable x.y.z version`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Orders two stable versions, ascending. */
function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/**
 * The highest stable version below `current`, or `undefined` when there is none.
 *
 * @param {readonly string[]} published - Every published version.
 * @param {string} current - Version being released.
 */
export function previousVersion(published, current) {
  return published
    .filter((v) => STABLE_VERSION_RE.test(v) && compareVersions(v, current) < 0)
    .sort(compareVersions)
    .at(-1)
}

/** Declaration files under `root`, as paths relative to it, in a stable order. */
function declarationFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (DECLARATION_FILE_RE.test(entry)) found.push(relative(root, path))
    }
  }
  if (existsSync(root)) walk(root)
  return found.sort()
}

/**
 * Compares two `dist/` directories.
 *
 * @param {string} previousDist - `dist/` of the previous published version.
 * @param {string} currentDist - `dist/` of this tree.
 * @returns {{ file: string, diff: string }[]} One entry per declaration file that differs; a
 *   file present on one side only is reported as such.
 */
export function compareDist(previousDist, currentDist) {
  const names = [
    ...new Set([...declarationFiles(previousDist), ...declarationFiles(currentDist)])
  ].sort()
  const differences = []
  for (const file of names) {
    const before = join(previousDist, file)
    const after = join(currentDist, file)
    if (!existsSync(before) || !existsSync(after)) {
      differences.push({ file, diff: existsSync(before) ? 'removed' : 'added' })
      continue
    }
    const left = normalizeDeclarations(readFileSync(before, 'utf8'))
    const right = normalizeDeclarations(readFileSync(after, 'utf8'))
    if (left !== right) differences.push({ file, diff: lineDiff(left, right) })
  }
  return differences
}

/** A line diff of two texts: `-` for removed lines, `+` for added ones, in file order. */
function lineDiff(left, right) {
  const a = left.split('\n')
  const b = right.split('\n')
  // Longest-common-subsequence lengths of the suffixes a[i..] and b[j..], keyed "i,j".
  const common = new Map()
  const lcs = (i, j) => common.get(`${i},${j}`) ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common.set(
        `${i},${j}`,
        a.at(i) === b.at(j) ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
      )
    }
  }
  const lines = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a.at(i) === b.at(j)) {
      i++
      j++
    } else if (j < b.length && (i === a.length || lcs(i, j + 1) >= lcs(i + 1, j))) {
      lines.push(`+ ${b.at(j++)}`)
    } else {
      lines.push(`- ${a.at(i++)}`)
    }
  }
  return lines.join('\n')
}

/** Runs a command and returns its stdout, throwing with its stderr on failure. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error}`)
  }
  return result.stdout
}

/** Extracts a package tarball and returns the directory holding its `dist/`. */
function unpack(tarball) {
  const target = mkdtempSync(join(tmpdir(), 'api-surface-'))
  mkdirSync(target, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', target])
  return join(target, 'package', 'dist')
}

/** Resolves the `dist/` to compare against: `--against`, else the previous published version. */
function resolvePrevious(name, current, against) {
  if (against !== undefined) {
    const path = resolve(against)
    if (statSync(path).isDirectory()) return { dist: join(path, 'dist'), label: path }
    return { dist: unpack(path), label: path }
  }
  const published = JSON.parse(run('npm', ['view', name, 'versions', '--json']))
  const previous = previousVersion(Array.isArray(published) ? published : [published], current)
  if (previous === undefined) return undefined
  const scratch = mkdtempSync(join(tmpdir(), 'api-surface-pack-'))
  const packed = JSON.parse(
    run('npm', [
      'pack',
      `${name}@${previous}`,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      scratch
    ])
  )
  return {
    dist: unpack(join(scratch, packed[0].filename)),
    label: `${name}@${previous}`,
    version: previous
  }
}

function main() {
  const args = process.argv.slice(2)
  const flag = args.indexOf('--against')
  const against = flag === -1 ? undefined : args[flag + 1]
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const previous = resolvePrevious(manifest.name, manifest.version, against)
  if (previous === undefined) {
    console.log(`No earlier published version of ${manifest.name}: nothing to compare against.`)
    return 0
  }
  const previousVersionNumber =
    previous.version ??
    JSON.parse(readFileSync(join(previous.dist, '..', 'package.json'), 'utf8')).version
  const bump = classifyBump(previousVersionNumber, manifest.version)
  const differences = compareDist(previous.dist, resolve('dist'))
  console.log(
    `Public declarations ${manifest.version} against ${previous.label} (${previousVersionNumber}): ${bump} bump, ` +
      `${differences.length === 0 ? 'no difference' : `${differences.length} file(s) differ`}.`
  )
  for (const { file, diff } of differences) console.log(`\n--- ${file}\n${diff}`)
  if (differences.length > 0 && bump === 'patch') {
    console.error(
      '\nA patch must not change the public declarations. Either the change is not a patch, ' +
        'and the version must move to a minor or a major, or it must not alter a member, ' +
        'signature, modifier or declaration order. This check is necessary, not sufficient: ' +
        'it sees the type surface only, never behaviour or defaults.'
    )
    return 1
  }
  if (differences.length === 0) {
    console.log('This check is necessary, not sufficient: it sees the type surface only.')
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
