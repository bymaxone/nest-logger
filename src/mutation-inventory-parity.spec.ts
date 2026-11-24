/**
 * Pins the Stryker ignore list to the inventory exempt list: a spec the mutation run leaves out is named,
 * with a reason, in `scripts/mutation-inventory.exempt.json`.
 *
 * Layer: repository, tests. The cold `Mutation (full)` run ends with an inventory step that fails when a
 * unit test did not run in it and its file is not exempt. A spec added to `testPathIgnorePatterns` of
 * `jest.stryker.config.ts` and not to the exempt list therefore costs a whole cold run (about 75
 * minutes) before anything says so; this spec says so in seconds. It reads the Stryker configuration and
 * the JSON, and runs no other code of the package.
 */
import { readFileSync } from 'node:fs'
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
})
