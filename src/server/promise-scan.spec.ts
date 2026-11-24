/**
 * Verifies that no production file reads a static or a method of `Promise` that a program can replace
 * after the library loads: `Promise.resolve`, `race`, `all`, `any`, `allSettled`, `reject`, `try` and
 * `withResolvers`, bracket access and destructuring of the constructor, `new Promise` outside the
 * intrinsic constructor, `.then(`, `.catch(`, `.finally(` and `then.call(`. A site that stays is listed
 * below by file and count, with why it decides nothing.
 *
 * Layer: server, tests. Reads the text of `src` with comments removed; runs nothing of it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ['a static or bracket read of Promise', /(?<![A-Za-z0-9_$])Promise\s*(?:\?\.|\.|\[)/g],
  ['a new Promise', /\bnew\s+Promise\b/g],
  ['Promise taken whole', /=\s*Promise\b(?!\s*[<.])/g],
  ['then, catch or finally called', /\.\s*(?:then|catch|finally)\s*\(/g],
  ['then.call', /\bthen\s*\.\s*call\b/g]
]

/** Sites that stay, as `file|what`, with the count and why none of them reads an outcome. */
const EXEMPT: Readonly<Record<string, { count: number; reason: string }>> = {
  'server/services/destination-registry.service.ts|a new Promise': {
    count: 2,
    reason:
      'a wait for one event-loop turn and for the next drain poll: resolved by a timer, no outcome is read'
  },
  'server/destinations/pretty-dev.destination.ts|a new Promise': {
    count: 1,
    reason:
      'the end of a stream the destination owns: resolved by its own callback, no outcome of consumer code is read'
  }
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts'))
      found.push(path)
  }
  return found
}

const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Promise statics and methods in production source', () => {
  const found = new Map<string, number>()
  for (const file of sourceFiles(SRC)) {
    const text = withoutComments(readFileSync(file, 'utf8'))
    for (const [what, pattern] of BANNED) {
      const count = text.match(pattern)?.length ?? 0
      if (count > 0) found.set(`${relative(SRC, file)}|${what}`, count)
    }
  }

  /**
   * Given every production file under src
   * When it is read for the banned forms
   * Then each one found is a listed site with exactly the listed count
   */
  it('has no site that is not listed', () => {
    const unlisted = [...found].filter(([site, count]) => EXEMPT[site]?.count !== count)

    expect(unlisted).toEqual([])
  })

  /**
   * Given the list of sites that stay
   * When the source is read
   * Then every listed site is still there, so an entry left behind fails
   */
  it('lists no site that is gone', () => {
    const gone = Object.keys(EXEMPT).filter((site) => !found.has(site))

    expect(gone).toEqual([])
  })
})
