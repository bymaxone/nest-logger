/**
 * Tests of the suppression-baseline gate: how counts are read, what counts as growth, and the command's
 * exit status on a real repository, so the gate itself is held by a test and not by a habit.
 *
 * Layer: scripts.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { growthOf, parseSuppressions } from './check-suppressions-baseline.mjs'

const SCRIPT = fileURLToPath(new URL('./check-suppressions-baseline.mjs', import.meta.url))

/** A baseline text with the given counts for one rule. */
function baseline(counts) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(counts).map(([file, count]) => [file, { 'max-lines-per-function': { count } }])
    )
  )
}

describe('parseSuppressions', () => {
  it('reads one count per file and rule', () => {
    const counts = parseSuppressions(baseline({ 'a.ts': 2, 'b.ts': 1 }), 'x')
    assert.equal(counts.get(JSON.stringify(['a.ts', 'max-lines-per-function'])), 2)
    assert.equal(counts.size, 2)
  })

  it('refuses a file that is not an object keyed by file, and a count that is not whole', () => {
    assert.throws(() => parseSuppressions('[]', 'x'), /keyed by file/)
    assert.throws(() => parseSuppressions('{"a.ts":{"r":{"count":1.5}}}', 'x'), /no whole count/)
    assert.throws(() => parseSuppressions('{"a.ts":{"r":{}}}', 'x'), /no whole count/)
  })
})

describe('growthOf', () => {
  const base = parseSuppressions(baseline({ 'a.ts': 2 }), 'base')

  it('passes an unchanged baseline, a lower count and a removed entry', () => {
    assert.deepEqual(growthOf(parseSuppressions(baseline({ 'a.ts': 2 }), 'x'), base), [])
    assert.deepEqual(growthOf(parseSuppressions(baseline({ 'a.ts': 1 }), 'x'), base), [])
    assert.deepEqual(growthOf(parseSuppressions(baseline({}), 'x'), base), [])
  })

  it('fails a count that rose and names the file, the rule and both counts', () => {
    const problems = growthOf(parseSuppressions(baseline({ 'a.ts': 3 }), 'x'), base)
    assert.equal(problems.length, 1)
    assert.match(
      problems[0],
      /a\.ts: 3 `max-lines-per-function` suppression\(s\), the base revision has 2/
    )
  })

  it('fails an entry the base does not have', () => {
    const problems = growthOf(parseSuppressions(baseline({ 'a.ts': 2, 'new.ts': 1 }), 'x'), base)
    assert.equal(problems.length, 1)
    assert.match(problems.join('\n'), /new\.ts: 1 .* the base revision has 0/)
  })
})

describe('a file or rule name that holds a tab', () => {
  /** A baseline text with one suppression for each `[file, rule]` pair. */
  const pairs = (...entries) => {
    const data = {}
    for (const [file, rule] of entries) data[file] = { ...data[file], [rule]: { count: 1 } }
    return JSON.stringify(data)
  }
  /** The base holds (`src/a<TAB>b.ts`, `r`); the change holds (`src/a`, `b.ts<TAB>r`). */
  const baseText = pairs(['src/a\tb.ts', 'r'])
  const newText = pairs(['src/a', 'b.ts\tr'])

  it('keeps two different pairs apart even when joining them with a tab would give one key', () => {
    const current = parseSuppressions(newText, 'x')
    const base = parseSuppressions(baseText, 'x')
    const problems = growthOf(current, base)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /src\/a: 1 `b\.ts\tr` suppression\(s\), the base revision has 0/)
  })

  it('fails the command for a new suppression that shares a tab-joined key with a base one', () => {
    const root = mkdtempSync(join(tmpdir(), 'suppressions-'))
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    try {
      git('init', '-q')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'test')
      writeFileSync(join(root, 'eslint-suppressions.json'), baseText)
      git('add', '-A')
      git('commit', '-q', '-m', 'base')
      writeFileSync(join(root, 'eslint-suppressions.json'), newText)
      const result = spawnSync('node', [SCRIPT, '--root', root, '--base', 'HEAD'], {
        encoding: 'utf8'
      })
      assert.equal(result.status, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the command', () => {
  /** A repository whose first commit holds `committed` and whose working tree holds `working`. */
  function repository(committed, working) {
    const root = mkdtempSync(join(tmpdir(), 'suppressions-'))
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    if (committed !== null) writeFileSync(join(root, 'eslint-suppressions.json'), committed)
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    writeFileSync(join(root, 'eslint-suppressions.json'), working)
    return root
  }

  const run = (root, ...args) =>
    spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })

  it('exits 0 for a baseline that does not grow, and 1 for one that does', () => {
    const same = repository(baseline({ 'a.ts': 2 }), baseline({ 'a.ts': 2 }))
    const grown = repository(baseline({ 'a.ts': 2 }), baseline({ 'a.ts': 3 }))
    try {
      assert.equal(run(same, '--base', 'HEAD').status, 0)
      const result = run(grown, '--base', 'HEAD')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /a\.ts: 3 .* the base revision has 2/)
    } finally {
      rmSync(same, { recursive: true, force: true })
      rmSync(grown, { recursive: true, force: true })
    }
  })

  it('imposes nothing when the base revision has no baseline, and when no base is given', () => {
    const root = repository(null, baseline({ 'a.ts': 9 }))
    try {
      assert.equal(run(root, '--base', 'HEAD').status, 0)
      assert.equal(run(root).status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits non-zero for a base that is not a revision', () => {
    const root = repository(baseline({ 'a.ts': 1 }), baseline({ 'a.ts': 1 }))
    try {
      assert.notEqual(run(root, '--base', 'no-such-ref').status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
