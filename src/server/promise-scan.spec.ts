/**
 * Verifies that no production file reads a static or a method of `Promise` that a program can replace
 * after the library loads: `Promise.resolve`, `race`, `all`, `any`, `allSettled`, `reject`, `try` and
 * `withResolvers`, bracket access and destructuring of the constructor, `new Promise` outside the
 * intrinsic constructor, `.then(`, `.catch(`, `.finally(` and `then.call(`. A site that stays is listed
 * below by the line it stands on, with why it decides nothing.
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
  ['Promise read from globalThis', /globalThis\s*(?:\?\.\s*Promise|\.\s*Promise|\[)/g],
  ['then, catch or finally called', /\.\s*(?:then|catch|finally)\s*\(/g],
  ['then.call', /\bthen\s*\.\s*call\b/g],
  ['the captured intrinsic', /(?<![A-Za-z0-9_$])IntrinsicPromise\b/g]
]

/**
 * A site that stays: where it is (`file|what|line` and the next line, so two identical lines differ),
 * and why it reads no outcome a program could forge. Constructions from the captured intrinsic are
 * listed one by one and read "captured".
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'server/services/destination-registry.service.ts|a new Promise|await new Promise<void>((resolve) => {':
    'a wait for one event-loop turn (the first of two such lines): resolved by a timer callback, no outcome is read',
  'server/services/destination-registry.service.ts|a new Promise|await new Promise<void>((resolve) => { #2':
    'a wait for the next drain poll (the second of two such lines): resolved by a timer callback, no outcome is read',
  'server/destinations/pretty-dev.destination.ts|a new Promise|await new Promise<void>((resolve, reject) => {':
    'the end of a stream the destination owns: resolved by its own callback, no outcome of consumer code is read',
  'server/utils/native-promise.util.ts|the captured intrinsic|export const IntrinsicPromise = Object.getPrototypeOf((async (): Promise<void> => undefined)())':
    'captured: the definition, taken from an async function',
  'server/utils/native-promise.util.ts|the captured intrinsic|const nativeThen = Function.prototype.call.bind(IntrinsicPromise.prototype.then) as (':
    'captured: the then of the intrinsic prototype, bound once at load',
  'server/utils/native-promise.util.ts|the captured intrinsic|const promisePrototype = IntrinsicPromise.prototype as object':
    'captured: the prototype whose constructor the baseline reads',
  "server/utils/native-promise.util.ts|the captured intrinsic|if (own === undefined || !hasOwn(own, 'value') || own.value !== IntrinsicPromise) return false":
    'captured: a comparison with the intrinsic, no promise is awaited',
  'server/utils/native-promise.util.ts|the captured intrinsic|value: IntrinsicPromise,':
    'captured: the own constructor given to a promise that is dropped',
  "server/utils/with-timeout.util.ts|the captured intrinsic|import { absorb, awaitOutcome, IntrinsicPromise } from './native-promise.util'":
    'captured: the import',
  'server/utils/with-timeout.util.ts|the captured intrinsic|const wait = new IntrinsicPromise<void>((resolve, reject) => {':
    'captured: the deadline, built from the intrinsic constructor and settled by a timer or by the outcome box'
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

/** The line a match is on, whitespace collapsed: what names a site. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const end = text.indexOf('\n', index)
  return text
    .slice(start, end === -1 ? text.length : end)
    .trim()
    .replace(/\s+/g, ' ')
}

/** The sites of a text: `what|line`, the second of two identical lines suffixed `#2`, and so on. */
function sitesIn(source: string): Map<string, number> {
  const text = withoutComments(source)
  const sites = new Map<string, number>()
  for (const [what, pattern] of BANNED) {
    for (const hit of text.matchAll(pattern)) {
      const base = `${what}|${lineAt(text, hit.index)}`
      const seen = (sites.get(base) ?? 0) + 1
      sites.set(base, seen)
      if (seen > 1) sites.set(`${base} #${String(seen)}`, 1)
    }
  }
  return sites
}

describe('Promise statics and methods in production source', () => {
  const found = new Map<string, number>()
  for (const file of sourceFiles(SRC)) {
    for (const site of sitesIn(readFileSync(file, 'utf8')).keys()) {
      found.set(`${relative(SRC, file)}|${site}`, 1)
    }
  }

  /**
   * Given a line that aliases, destructures or reads a static of the global or captured promise
   * When the scan reads it
   * Then it is a site, so a new use cannot hide behind a local name
   */
  it.each([
    'const P = IntrinsicPromise',
    'const { resolve } = IntrinsicPromise',
    'return IntrinsicPromise.resolve(1)',
    'const { resolve } = Promise',
    'const P = Promise',
    'Promise.resolve(1)',
    'const P = globalThis.Promise',
    'const wait = new Promise(() => {})',
    'work.then(() => {})'
  ])('finds %s', (line) => {
    expect(sitesIn(line).size).toBeGreaterThan(0)
  })

  /**
   * Given every production file under src
   * When it is read for the banned forms
   * Then each one found is a listed site, one by one
   */
  it('has no site that is not listed', () => {
    const unlisted = [...found.keys()].filter((site) => EXEMPT[site] === undefined)

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
