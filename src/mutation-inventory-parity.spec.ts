/**
 * Pins the Stryker ignore list to the inventory exempt list: a spec the mutation run leaves out is named,
 * with a reason, in `scripts/mutation-inventory.exempt.json`.
 *
 * Layer: repository, tests. The cold `Mutation (full)` run ends with an inventory step that fails when a
 * unit test did not run in it and its file is not exempt. A spec added to `testPathIgnorePatterns` of
 * `jest.stryker.config.ts` and not to the exempt list therefore costs a whole cold run (about 75
 * minutes) before anything says so; this spec says so in seconds. The same holds for a spec that imports
 * nothing of the package: it covers no mutant, never runs in the mutation run, and is listed too. It
 * reads the Stryker configuration, the JSON and the text of the specs, and runs no other code of the package.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative as relativePath } from 'node:path'

const ROOT = join(__dirname, '..')

const EXEMPT = (
  JSON.parse(readFileSync(join(ROOT, 'scripts/mutation-inventory.exempt.json'), 'utf8')) as Array<{
    file: string
    reason: string
  }>
).map((entry) => entry.file)

/**
 * The patterns the Stryker configuration writes into `testPathIgnorePatterns`, read from its text: the
 * file imports the base configuration by a `.ts` path, which this suite's compiler does not accept.
 * The default `/node_modules/` is not one of them.
 */
const CONFIG = readFileSync(join(ROOT, 'jest.stryker.config.ts'), 'utf8')
const LIST = /testPathIgnorePatterns:\s*\[([\s\S]*?)\n\s*\]/.exec(CONFIG)?.[1] ?? ''
const ADDED = [...LIST.matchAll(/'((?:\\.|[^'\\])*)'/g)]
  .map((match) => (match[1] ?? '').replaceAll('\\\\', '\\'))
  .filter((pattern) => pattern !== '/node_modules/')

/**
 * The specifiers a source text imports as values: a type-only `import type` is erased when the file is
 * compiled, so it reaches no code of the package and does not count. A dynamic `import()`, a `require`,
 * a bare `import 'x'` and a re-export count, as does any `import` that names a value, even beside a type.
 */
function valueSpecifiers(text: string): string[] {
  const found: string[] = []
  const named = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(named)) {
    if (match[1] === undefined) found.push(match[2] ?? '')
  }
  const other = /\b(?:import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g
  for (const match of text.matchAll(other)) found.push(match[1] ?? '')
  return found
}

/** The file a relative specifier names from `from`, or `undefined` when it is not a TypeScript module. */
function resolveModule(from: string, specifier: string): string | undefined {
  const base = join(ROOT, from, '..', specifier)
  return [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
}

/**
 * Whether the text of `file` reaches code of the package: it imports the package by name, or a module of
 * `src`, or a helper under `__tests__` that does. A helper is followed because the spec runs what it runs.
 */
function linksToSource(file: string, text: string, seen: ReadonlySet<string> = new Set()): boolean {
  return valueSpecifiers(text).some((specifier) => {
    if (specifier.startsWith('@bymax-one/nest-logger')) return true
    if (!/^\.{1,2}\//.test(specifier)) return false
    const target = resolveModule(file, specifier)
    if (target === undefined || seen.has(target)) return false
    const relative = relativePath(ROOT, target).split('\\').join('/')
    if (!relative.includes('/__tests__/')) return true
    return linksToSource(relative, readFileSync(target, 'utf8'), new Set([...seen, target]))
  })
}

/**
 * Every spec under `src` that reaches no code of the package, by a static scan of its text. Stryker runs
 * a test only for a mutant it covers, so a spec that reaches none covers none, never runs in the mutation
 * run, and the inventory step fails unless the exempt list names it.
 */
const SPECS = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
  .filter((file) => file.endsWith('.spec.ts'))
  .map((file) => `src/${file.split('\\').join('/')}`)
const IMPORTS_NO_SOURCE = SPECS.filter(
  (file) => !linksToSource(file, readFileSync(join(ROOT, file), 'utf8'))
)

describe('the Stryker ignore list and the inventory exempt list', () => {
  /*
   * Given the patterns jest.stryker.config.ts adds to testPathIgnorePatterns
   * When each is matched, as Jest matches it, against the path of every exempt spec
   * Then every pattern matches at least one exempt entry
   */
  it('names every spec the Stryker run ignores in the exempt list', () => {
    const unlisted = ADDED.filter(
      (pattern) => !EXEMPT.some((file) => new RegExp(pattern).test(`/${file}`))
    )

    expect(unlisted).toStrictEqual([])
  })

  /*
   * Given the same patterns
   * When the list of them is read
   * Then it is not empty, so the row above judges something
   */
  it('reads at least one added pattern', () => {
    expect(ADDED.length).toBeGreaterThan(0)
  })

  /*
   * Given every spec under src whose text reaches no code of the package
   * When each is looked up in the exempt list
   * Then every one of them is there, because it covers no mutant and so never runs in the mutation run
   */
  it('names every spec that reaches no code of the package in the exempt list', () => {
    const unlisted = IMPORTS_NO_SOURCE.filter((file) => !EXEMPT.includes(file))

    expect(unlisted).toStrictEqual([])
  })

  /*
   * Given the same scan
   * When it is run over the specs the exempt list already names for reading text
   * Then it finds them, so an empty answer above is not a scan that matches nothing
   */
  it('finds the specs that read text, and not the ones that import the package', () => {
    expect(IMPORTS_NO_SOURCE).toContain('src/readme.exports.spec.ts')
    expect(IMPORTS_NO_SOURCE).not.toContain('src/server/binary-marker.spec.ts')
  })

  /*
   * Given specs whose only import of the package is a helper under __tests__ that imports its code
   * When the scan follows the helper
   * Then they count as linked, because they run what the helper runs
   */
  it('counts a spec that reaches the package only through a helper as linked', () => {
    expect(IMPORTS_NO_SOURCE).not.toContain('src/server/nested-error-shapes.a.spec.ts')
    expect(IMPORTS_NO_SOURCE).not.toContain('src/server/nested-error-shapes.blind.spec.ts')
  })

  /*
   * Given a text whose only relative imports are `import type`, one of them over several lines
   * When its imports are read as values
   * Then none is found, because a type-only import is erased and reaches no code
   */
  it('does not count a type-only import as reaching the package', () => {
    const text = [
      "import type { A } from './a'",
      'import type {',
      '  B,',
      '  C',
      "} from '../b'",
      "import type * as ns from './ns'"
    ].join('\n')

    expect(valueSpecifiers(text)).toStrictEqual([])
    expect(linksToSource('src/x.spec.ts', text)).toBe(false)
  })

  /*
   * Given a text that imports a value of src, a helper under __tests__ and a type
   * When the scan reads it
   * Then it is linked, and every one of the value specifiers is found, the type one is not
   */
  it('counts a spec that imports src values together with a helper and a type as linked', () => {
    const text = [
      "import { buildPinoInstance } from './pino-factory'",
      "import { makeOptions } from './__tests__/pino-factory.fixtures'",
      "import type { Options } from './interfaces/options'"
    ].join('\n')

    expect(valueSpecifiers(text)).toStrictEqual([
      './pino-factory',
      './__tests__/pino-factory.fixtures'
    ])
    expect(linksToSource('src/server/x.spec.ts', text)).toBe(true)
  })

  /*
   * Given a dynamic import, a require, a bare import and a re-export of the package
   * When the scan reads each
   * Then each is a value specifier
   */
  it('counts a dynamic import, a require, a bare import and a re-export as values', () => {
    const text = [
      "const a = await import('./a')",
      "const b = require('./b')",
      "import './c'",
      "export { d } from './d'",
      "import e, { type F } from './e'"
    ].join('\n')

    expect(valueSpecifiers(text)).toStrictEqual(['./d', './e', './a', './b', './c'])
  })
})
