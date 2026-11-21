/**
 * @fileoverview Tests of the property-path gate: what is a dotted path, the multi-line call, and the
 * command's exit status on a repository with a planted offender, so the gate is held by a test.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dottedPathHits } from './check-have-property-path.mjs'

const SCRIPT = fileURLToPath(new URL('./check-have-property-path.mjs', import.meta.url))

describe('dottedPathHits', () => {
  it('flags a negative assertion on a key with a dot, which could never fail', () => {
    const hits = dottedPathHits("expect(out).not.toHaveProperty('exception.stacktrace')\n")
    assert.deepEqual(hits, [{ line: 1, path: 'exception.stacktrace' }])
  })

  it('flags a positive path, a double-quoted and a template literal, with the value', () => {
    const text = 'a.toHaveProperty("a.b", 1)\nb.toHaveProperty(`c.d`)\n'
    assert.deepEqual(dottedPathHits(text), [
      { line: 1, path: 'a.b' },
      { line: 2, path: 'c.d' }
    ])
  })

  it('flags a call whose string is on the next line', () => {
    const text = 'expect(out).not.toHaveProperty(\n  "exception.message"\n)\n'
    assert.deepEqual(dottedPathHits(text), [{ line: 1, path: 'exception.message' }])
  })

  it('reads a string with an escaped quote to its end', () => {
    const text = "x.toHaveProperty('a\\'b.c')\n"
    assert.deepEqual(dottedPathHits(text), [{ line: 1, path: "a\\'b.c" }])
  })

  it('accepts the key form, a key without a dot, and a variable', () => {
    const text =
      "a.toHaveProperty(['exception.stacktrace'])\nb.toHaveProperty('message')\nc.toHaveProperty(key)\n"
    assert.deepEqual(dottedPathHits(text), [])
  })

  it('counts the line of each hit', () => {
    const text = "line one\nline two\nx.toHaveProperty('a.b')\n"
    assert.equal(dottedPathHits(text)[0]?.line, 3)
  })
})

describe('the command', () => {
  const repo = (spec) => {
    const root = mkdtempSync(join(tmpdir(), 'have-property-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.spec.ts'), spec)
    execFileSync('git', ['add', '.'], { cwd: root })
    return root
  }
  const run = (root) => spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' })

  it('fails on a planted offender and names the file and the line', () => {
    const root = repo("x.not.toHaveProperty('exception.stacktrace')\n")
    try {
      const result = run(root)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /src\/a\.spec\.ts:1 toHaveProperty\('exception\.stacktrace'\)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes on the key form', () => {
    const root = repo("x.not.toHaveProperty(['exception.stacktrace'])\n")
    try {
      const result = run(root)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /No toHaveProperty call/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
