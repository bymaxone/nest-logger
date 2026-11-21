/**
 * @fileoverview Holds the table of symbols drawn as a Latin letter to what Unicode data says: the
 * generated module is what the generator makes of the checked-in names, and it holds the three blocks.
 * @layer scripts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { generate } from './generate-glyph-letters.mjs'

const names = readFileSync(new URL('./unicode/latin-letter-names.txt', import.meta.url), 'utf8')
const generated = readFileSync(
  new URL('../src/server/utils/glyph-letters.generated.ts', import.meta.url),
  'utf8'
)

describe('the glyph letter table', () => {
  it('is what the generator makes of the checked-in names, byte for byte', () => {
    assert.equal(generated, generate(names))
  })

  it('holds the negative circled, the negative squared and the regional indicator letters', () => {
    const table = generate(names)
    for (const first of ['0x1f150', '0x1f170', '0x1f1e6']) assert.match(table, new RegExp(first))
  })

  it('leaves out a symbol that decomposes, a letter and a mark', () => {
    const table = generate(names)
    assert.doesNotMatch(table, /0x24b6/)
    assert.doesNotMatch(table, /0xe0041/)
  })
})
