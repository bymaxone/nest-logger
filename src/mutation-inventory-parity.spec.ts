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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * Every spec under `src` that imports no module by a relative path or by the package's own name, by a static scan of its text.
 * Stryker runs a test only for a mutant it covers, so a spec that reaches no module of the package covers
 * none, never runs in the mutation run, and the inventory step fails unless the exempt list names it.
 * A dynamic `import()` and a `require` count as an import, so a spec is asked for an entry only when
 * nothing at all links it to the package.
 */
const SPECS = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
  .filter((file) => file.endsWith('.spec.ts'))
  .map((file) => `src/${file.split('\\').join('/')}`)
const IMPORTS_NO_SOURCE = SPECS.filter(
  (file) =>
    !/(?:from|import|require)\s*\(?\s*['"](?:\.{1,2}\/|@bymax-one\/nest-logger)/.test(
      readFileSync(join(ROOT, file), 'utf8')
    )
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
   * Given every spec under src whose text imports nothing by a relative path
   * When each is looked up in the exempt list
   * Then every one of them is there, because it covers no mutant and so never runs in the mutation run
   */
  it('names every spec that imports nothing of the package in the exempt list', () => {
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
})
