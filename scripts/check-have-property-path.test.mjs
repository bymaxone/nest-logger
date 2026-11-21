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
    assert.deepEqual(hits, [{ line: 1, path: 'exception.stacktrace', literal: true }])
  })

  it('flags a positive path, a double-quoted and a template literal, with the value', () => {
    const text = 'a.toHaveProperty("a.b", 1)\nb.toHaveProperty(`c.d`)\n'
    assert.deepEqual(dottedPathHits(text), [
      { line: 1, path: 'a.b', literal: true },
      { line: 2, path: 'c.d', literal: true }
    ])
  })

  it('flags a call whose string is on the next line', () => {
    const text = 'expect(out).not.toHaveProperty(\n  "exception.message"\n)\n'
    assert.deepEqual(dottedPathHits(text), [{ line: 1, path: 'exception.message', literal: true }])
  })

  it('reads a string with an escaped quote to its end', () => {
    const text = "x.toHaveProperty('a\\'b.c')\n"
    assert.deepEqual(dottedPathHits(text), [{ line: 1, path: "a\\'b.c", literal: true }])
  })

  it('accepts the key form, in every spelling, and a key without a dot', () => {
    const text =
      "a.toHaveProperty(['exception.stacktrace'])\nb.toHaveProperty('message')\nc.toHaveProperty([key])\nd.toHaveProperty( [key] , 1)\n"
    assert.deepEqual(dottedPathHits(text), [])
  })

  it('flags a variable, whose value may hold a dot', () => {
    assert.deepEqual(dottedPathHits('c.toHaveProperty(key)\n'), [
      { line: 1, path: 'key', literal: false }
    ])
    assert.deepEqual(dottedPathHits('c.toHaveProperty(key, 1)\n'), [
      { line: 1, path: 'key', literal: false }
    ])
  })

  it('flags a concatenation and a template with a substitution', () => {
    assert.equal(dottedPathHits("c.toHaveProperty('a' + b)\n").length, 1)
    assert.equal(dottedPathHits('c.toHaveProperty(`a${b}`)\n').length, 1)
  })

  it('reads a call with a space before the paren, and a variable on the next line', () => {
    assert.equal(dottedPathHits("c.toHaveProperty ('a.b')\n").length, 1)
    assert.deepEqual(dottedPathHits('c.toHaveProperty(\n  key\n)\n'), [
      { line: 1, path: 'key', literal: false }
    ])
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
