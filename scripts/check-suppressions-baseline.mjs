#!/usr/bin/env node
/**
 * Suppression-baseline gate: `eslint-suppressions.json` may shrink and may not grow.
 *
 * Layer: scripts.
 *
 * ESLint's bulk suppressions record the violations a rule had when it was introduced, so the rule fails
 * on what a change adds and not on what the repository inherits, and ESLint fails on a suppression that
 * no longer matches a violation. Nothing in ESLint stops the file from being regenerated with
 * `--suppress-rule` after a new violation is added, which turns that violation into inherited debt. A
 * pull request is therefore compared with the baseline of its base revision: a count that rose, or an
 * entry the base does not have, fails. A base revision without a baseline imposes nothing, which is the
 * change that introduces it.
 *
 * Plain Node with no dependencies.
 *
 * Usage: node scripts/check-suppressions-baseline.mjs [--root <dir>] [--base <ref>]
 *   --root  repository root (default: the current directory)
 *   --base  a git revision whose baseline the current one may not exceed (default: none, which checks
 *           only that the file parses)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The baseline's name at the repository root, which ESLint reads by default. */
const BASELINE = 'eslint-suppressions.json'

/**
 * Reads the suppression counts from the JSON text of a baseline.
 *
 * @param {string} text The baseline file's text.
 * @param {string} where Where it came from, for the message.
 * @returns {Map<string, number>} The count of each suppression, keyed by `JSON.stringify([file, rule])`, which no file or rule name can make collide.
 */
export function parseSuppressions(text, where) {
  const counts = new Map()
  const data = JSON.parse(text)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${where}: expected an object keyed by file`)
  }
  for (const [file, rules] of Object.entries(data)) {
    for (const [rule, entry] of Object.entries(rules ?? {})) {
      const count = entry?.count
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${where}: ${file} ${rule} has no whole count`)
      }
      counts.set(JSON.stringify([file, rule]), count)
    }
  }
  return counts
}

/**
 * The suppressions that grew: a count above the base's, or an entry the base does not have.
 *
 * @param {Map<string, number>} current The counts in the change.
 * @param {Map<string, number>} base The counts at the base revision.
 * @returns {string[]} One message per suppression that grew.
 */
export function growthOf(current, base) {
  const problems = []
  for (const [key, count] of current) {
    const before = base.get(key) ?? 0
    if (count > before) {
      const [file, rule] = JSON.parse(key)
      problems.push(
        `${file}: ${String(count)} \`${rule}\` suppression(s), the base revision has ${String(before)}. Fix the violation instead of suppressing it.`
      )
    }
  }
  return problems
}

/**
 * The baseline at a git revision, or `null` when that revision has none.
 *
 * @param {string} root The repository root.
 * @param {string} ref The git revision.
 * @returns {Map<string, number> | null} The counts at that revision, or `null`.
 */
function baselineAt(root, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
  } catch {
    throw new Error(`${ref}: not a revision in this repository`)
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${BASELINE}`], { cwd: root, stdio: 'ignore' })
  } catch {
    return null
  }
  const text = execFileSync('git', ['show', `${ref}:${BASELINE}`], { cwd: root, encoding: 'utf8' })
  return parseSuppressions(text, `${ref}:${BASELINE}`)
}

/**
 * Reads `--name value` from the arguments, or returns the fallback.
 *
 * @param {string} name The option name.
 * @param {string | undefined} fallback Used when the option is absent.
 * @returns {string | undefined} The option's value or the fallback.
 */
function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

/** Runs the gate and exits non-zero when the baseline grew. */
function main() {
  const root = resolve(option('--root', process.cwd()))
  const current = parseSuppressions(readFileSync(join(root, BASELINE), 'utf8'), BASELINE)
  const ref = option('--base', undefined)
  const base = ref === undefined ? null : baselineAt(root, ref)
  const problems = base === null ? [] : growthOf(current, base)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`\n${String(problems.length)} suppression(s) added to ${BASELINE}.`)
    process.exit(1)
  }
  console.log(`${BASELINE} does not grow.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
