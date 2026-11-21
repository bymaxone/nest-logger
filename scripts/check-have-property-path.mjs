#!/usr/bin/env node
/**
 * @fileoverview Property-path gate: a string with a dot given to `toHaveProperty` is a nested PATH, so a
 * negative assertion on a key that has a dot in its name (`exception.stacktrace`) can never fail.
 * @layer scripts
 *
 * Jest reads `toHaveProperty('a.b')` as "the property `b` of the property `a`". The semantic-convention
 * fields the logger writes (`exception.stacktrace`, `service.name`) are keys whose names hold a dot, so
 * `expect(line).not.toHaveProperty('exception.stacktrace')` passes whatever the line holds. The key form
 * is `toHaveProperty(['exception.stacktrace'])`.
 *
 * Every tracked `.ts` file under `src` and `test` is read, the call may span lines or have a space before
 * the paren, and a literal with a dot in it, or any argument that is not a literal (a variable, a
 * concatenation), is a hit. A key is written as an array, which Jest reads as one key, and a nested
 * path as an array of its keys, so nothing legitimate is refused.
 *
 * Plain Node with no dependencies.
 *
 * Usage: node scripts/check-have-property-path.mjs [--root <dir>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** `toHaveProperty`, optional space, `(`, and the white space before the first argument. */
const OPEN = /toHaveProperty\s*\(\s*/g

/** A string literal that ends the argument (`,` or `)` follows), with escapes. */
const LITERAL = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/

/**
 * The calls of a text whose first argument is not a key that holds no dot: a string with a dot, which
 * Jest reads as a path, and any expression that is not a literal (a variable, a concatenation, a
 * template with a substitution), whose value no reader of the line can tell. A key is written as an
 * array, `['a.b']`, which Jest reads as one key whatever it holds.
 *
 * @param {string} text - The source of a file.
 * @returns {Array<{ line: number, path: string, literal: boolean }>} One entry for each such call.
 */
export function dottedPathHits(text) {
  const hits = []
  for (const match of text.matchAll(OPEN)) {
    const rest = text.slice(match.index + match[0].length)
    if (rest.startsWith('[')) continue
    const line = text.slice(0, match.index).split('\n').length
    const literal = LITERAL.exec(rest)
    if (literal === null) {
      hits.push({ line, path: rest.split(/[,)\n]/)[0].trim(), literal: false })
    } else if (literal[2].includes('.') || (literal[1] === '`' && literal[2].includes('${'))) {
      hits.push({ line, path: literal[2], literal: true })
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
    dottedPathHits(readFileSync(join(root, file), 'utf8')).map((hit) =>
      hit.literal
        ? `${file}:${hit.line} toHaveProperty('${hit.path}') reads a path; write toHaveProperty(['${hit.path}']) for a key with a dot`
        : `${file}:${hit.line} toHaveProperty(${hit.path}) takes a value that may hold a dot, which Jest reads as a path; write toHaveProperty([${hit.path}])`
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
