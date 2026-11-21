#!/usr/bin/env node
/**
 * @fileoverview Property-path gate: a string with a dot given to `toHaveProperty` is a nested PATH, so a
 * negative assertion on a key that has a dot in its name (`exception.stacktrace`) can never fail.
 * @layer scripts
 *
 * Jest reads `toHaveProperty('a.b')` as "the property `b` of the property `a`". The semantic-convention
 * fields the logger writes (`exception.stacktrace`, `service.name`) are keys whose names hold a dot, so
 * `expect(line).not.toHaveProperty('exception.stacktrace')` passes whatever the line holds. The key form
 * is `toHaveProperty(['exception.stacktrace'])`. Found by a mutation run that stayed green on a deleted
 * condition: the assertion that should have caught it was of the path form.
 *
 * Every tracked `.ts` file under `src` and `test` is read, the call may span lines, and a string, a
 * template or a quoted literal with a dot in it is a hit. A nested path is written as an array of its
 * keys, so nothing legitimate is refused.
 *
 * Plain Node with no dependencies.
 *
 * Usage: node scripts/check-have-property-path.mjs [--root <dir>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** `toHaveProperty(` and the string literal that follows, which may be on the next line. */
const CALL = /toHaveProperty\(\s*(['"`])([^'"`]*)\1/g

/**
 * The lines of a text where `toHaveProperty` takes a string that holds a dot.
 *
 * @param {string} text - The source of a file.
 * @returns {Array<{ line: number, path: string }>} One entry for each call that is a path.
 */
export function dottedPathHits(text) {
  const hits = []
  for (const match of text.matchAll(CALL)) {
    const path = match[2]
    if (path.includes('.')) {
      hits.push({ line: text.slice(0, match.index).split('\n').length, path })
    }
  }
  return hits
}

/**
 * The tracked TypeScript files under `src` and `test`.
 *
 * @param {string} root - The repository root.
 * @returns {string[]} Paths relative to the root.
 */
function trackedFiles(root) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test'], {
    cwd: root,
    encoding: 'utf8'
  })
  return listed.split('\0').filter((file) => file.endsWith('.ts'))
}

/**
 * Run the gate over a repository.
 *
 * @param {string} root - The repository root.
 * @returns {string[]} One message for each call that is a dotted path.
 */
export function problemsOf(root) {
  return trackedFiles(root).flatMap((file) =>
    dottedPathHits(readFileSync(join(root, file), 'utf8')).map(
      (hit) =>
        `${file}:${hit.line} toHaveProperty('${hit.path}') reads a path; write toHaveProperty(['${hit.path}']) for a key with a dot`
    )
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--root')
  const root = resolve(at === -1 ? '.' : (process.argv[at + 1] ?? '.'))
  const problems = problemsOf(root)
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  if (problems.length > 0) process.exit(1)
  process.stdout.write('No toHaveProperty call takes a dotted string as a path.\n')
}
