/**
 * Pins the README to the public surface: every export of every public subpath is named in it.
 *
 * Layer: root, tests. The README is published to npm and is where a consumer learns what the
 * package offers, so an export the README never names is an export nobody can find. The barrels
 * are read through the TypeScript compiler, not by pattern, so a re-export, a type and a
 * renamed export are all seen.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

const ROOT = join(__dirname, '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
}

/** The source barrel that builds each public subpath. */
const BARRELS: Readonly<Record<string, string>> = {
  '.': 'src/server/index.ts',
  './shared': 'src/shared/index.ts'
}

/** The public subpaths named by `package.json`, apart from the manifest itself. */
const SUBPATHS = Object.keys(PACKAGE.exports).filter((subpath) => subpath !== './package.json')

/** The names a barrel exports, values and types alike. */
function exportsOf(barrel: string): string[] {
  const program = ts.createProgram([join(ROOT, barrel)], {
    strict: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(join(ROOT, barrel))
  const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
  return symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((entry) => entry.name)
}

describe('the README names every export of a public subpath', () => {
  it('knows the barrel of every subpath package.json publishes', () => {
    expect(SUBPATHS.filter((subpath) => !(subpath in BARRELS))).toEqual([])
  })

  it.each(SUBPATHS)('%s', (subpath) => {
    const names = exportsOf(BARRELS[subpath] ?? '')

    expect(names.length).toBeGreaterThan(0)
    const missing = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(README))
    expect(missing).toEqual([])
  })
})
