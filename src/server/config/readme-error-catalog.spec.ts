/**
 * Pins the README's error catalog to the errors the library really throws and emits.
 *
 * Layer: server/config, tests. A thrown error carries no code string, so a catalog keyed by
 * invented codes drifts without anything failing. These cases scan every throw site in `src`
 * and hold the catalog against it, in both directions.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

const ROOT = join(__dirname, '..', '..', '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf-8')

/** The catalog section, from its heading to the next top-level one. */
const CATALOG = (() => {
  const start = README.indexOf('## 🚨 Error Code Catalog')
  const end = README.indexOf('\n## ', start + 1)
  return README.slice(start, end)
})()

/** Every production source file under `src`, specs excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** The message prefix of every `throw new Error('[Class] ...')` in `src`, with its file. */
function thrownPrefixes(): { file: string; prefix: string }[] {
  const found: { file: string; prefix: string }[] = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf-8')
    for (const match of text.matchAll(/throw new Error\(\s*[`']\[(\w+)\] ([^`'$]*)/g)) {
      const message = (match[2] ?? '').trim()
      // Every option the validator rejects names its own path, so they share one row.
      const words = message.startsWith('options.') ? ['options.'] : message.split(' ').slice(0, 2)
      found.push({ file, prefix: `[${match[1] ?? ''}] ${words.join(' ')}` })
    }
  }
  return found
}

/** The first column of a catalog table, backticks stripped. */
function firstColumn(): string[] {
  return CATALOG.split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|')[1]?.trim().replace(/^`|`$/g, '') ?? '')
}

describe('README error catalog', () => {
  it(/*
   * A thrown error is only findable by its message. A throw site the catalog does not name
   * is an error a consumer meets and cannot look up.
   */
  'names the message of every throw site in src', () => {
    const sites = thrownPrefixes()
    expect(sites.length).toBeGreaterThanOrEqual(7)
    const missing = sites.filter(({ prefix }) => !CATALOG.includes(prefix.replace(/\.$/, '')))
    expect(missing).toEqual([])
  })

  it(/*
   * The reverse: a thrown-error row whose message no source file contains documents an error
   * the library does not throw.
   */
  'lists no thrown error that src does not throw', () => {
    const source = sourceFiles(join(ROOT, 'src'))
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n')
    const rows = firstColumn().filter((cell) => cell.startsWith('['))
    expect(rows.length).toBeGreaterThanOrEqual(7)
    const stale = rows.filter((cell) => !source.includes(cell))
    expect(stale).toEqual([])
  })

  it(/*
   * A log-key row is only worth listing if the library can write it. Every uppercase code in
   * the second table must be a reserved key, so a renamed or removed key fails here.
   */
  'lists only log keys the library reserves', () => {
    const codes = firstColumn().filter((cell) => /^[A-Z][A-Z_]+$/.test(cell))
    expect(codes.length).toBeGreaterThanOrEqual(5)
    const reserved = Object.values(RESERVED_LOG_KEYS) as string[]
    expect(codes.filter((code) => !reserved.includes(code))).toEqual([])
  })
})
