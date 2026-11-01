/**
 * Pins `scripts/check-api-surface.mjs`, the gate that fails a PATCH whose built public
 * declarations differ from the previous published version.
 *
 * Layer: repository tooling, tests. The script is plain Node and is run here the way the
 * release workflow runs it, as a child process against two small `dist/` directories, so
 * the exit code and the printed diff are what the cases assert.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'check-api-surface.mjs')

const BASE = `/** Writes entries. */
export declare class Logger {
    readonly name: string;
    info(message: string): void;
}
interface Options {
    level?: string;
}
export { Logger, type Options };
`

interface Result {
  readonly status: number | null
  readonly output: string
}

const roots: string[] = []

/** Lays out `{ package.json, dist/index.d.ts, dist/index.d.cts }` and returns its root. */
function layout(version: string, declarations: string): string {
  const root = mkdtempSync(join(tmpdir(), 'api-surface-spec-'))
  roots.push(root)
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-lib', version }))
  writeFileSync(join(root, 'dist', 'index.d.ts'), declarations)
  writeFileSync(join(root, 'dist', 'index.d.cts'), declarations)
  return root
}

/** Runs the gate for `declarations` as version `next`, against `BASE` published as 1.4.4. */
function check(declarations: string, next = '1.4.5'): Result {
  const previous = layout('1.4.4', BASE)
  const current = layout(next, declarations)
  const run = spawnSync('node', [SCRIPT, '--against', previous], { cwd: current, encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('check-api-surface', () => {
  describe('a patch that changes the public declarations fails', () => {
    it.each([
      [
        'an added public method',
        BASE.replace(
          'info(message: string): void;',
          'info(message: string): void;\n    warn(message: string): void;'
        )
      ],
      [
        'an added optional parameter',
        BASE.replace('info(message: string)', 'info(message: string, context?: object)')
      ],
      ['a flipped readonly modifier', BASE.replace('readonly name: string;', 'name: string;')],
      [
        'a reordered member',
        BASE.replace(
          '    readonly name: string;\n    info(message: string): void;',
          '    info(message: string): void;\n    readonly name: string;'
        )
      ],
      [
        'an added private member',
        BASE.replace('readonly name: string;', 'readonly name: string;\n    private buffer;')
      ],
      ['a removed member', BASE.replace('    readonly name: string;\n', '')],
      ['an added path reference directive', `/// <reference path="./ambient.d.ts" />\n${BASE}`],
      ['an added types reference directive', `/// <reference types="node" />\n${BASE}`],
      ['an added lib reference directive', `/// <reference lib="es2022" />\n${BASE}`],
      ['an added no-default-lib directive', `/// <reference no-default-lib="true"/>\n${BASE}`],
      [
        'an added exported name',
        BASE.replace(
          'export { Logger, type Options };',
          'export { Logger, type Options, type Extra };\ninterface Extra {}'
        )
      ],
      [
        'a value export turned type-only',
        BASE.replace('export { Logger, type Options };', 'export { type Logger, type Options };')
      ]
    ])('%s', (_name, declarations) => {
      /*
       * Scenario: each row is a change a reader could take for "nothing changed" and that
       * alters the type surface of a published patch. The gate must exit 1, print the
       * differing file, and say why a patch may not do this.
       */
      const { status, output } = check(declarations)
      expect(status).toBe(1)
      expect(output).toContain('index.d.ts')
      expect(output).toContain('A patch must not change the public declarations')
    })
  })

  describe('a patch that changes no declaration passes', () => {
    it.each([
      [
        'a JSDoc-only change',
        BASE.replace(
          '/** Writes entries. */',
          '/**\n * Writes structured entries.\n * @deprecated for illustration only\n */'
        )
      ],
      [
        'a whitespace-only change',
        BASE.replace(/ {4}/g, '\t').replace(
          'export { Logger, type Options };',
          'export {   Logger,   type Options   };'
        )
      ],
      [
        'the same names re-emitted as separate value and type export lists',
        BASE.replace(
          'export { Logger, type Options };',
          'export type { Options };\nexport { Logger };'
        )
      ]
    ])('%s', (_name, declarations) => {
      /*
       * Scenario: comments, formatting and the grouping of an export list are bundler or
       * documentation output, not API. The gate must exit 0 and report no difference.
       */
      const { status, output } = check(declarations)
      expect(status).toBe(0)
      expect(output).toContain('no difference')
    })
  })

  it.each(['1.5.0', '2.0.0'])(
    'lets a changed declaration through when the version moves to %s',
    (next) => {
      /*
       * Scenario: the same added method that fails as a patch is the expected content of a
       * minor or a major, so the differences are printed for the reader and the exit is 0.
       */
      const { status, output } = check(
        BASE.replace(
          'info(message: string): void;',
          'info(message: string): void;\n    warn(message: string): void;'
        ),
        next
      )
      expect(status).toBe(0)
      expect(output).toContain('+     warn(message: string): void;')
    }
  )

  it('treats the same reference directives in another order as no difference', () => {
    /*
     * Scenario: the order of triple-slash directives carries no meaning, so the bundler
     * emitting them in another order must not fail a patch, while removing one must.
     */
    const directives = ['/// <reference types="node" />', '/// <reference path="./a.d.ts" />']
    const previous = layout('1.4.4', `${directives.join('\n')}\n${BASE}`)
    const current = layout('1.4.5', `${[...directives].reverse().join('\n')}\n${BASE}`)
    const run = spawnSync('node', [SCRIPT, '--against', previous], {
      cwd: current,
      encoding: 'utf8'
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('no difference')
  })

  it('reports a declaration file that exists on one side only', () => {
    /*
     * Scenario: a new `.d.cts` or a removed `.d.ts` changes what a consumer resolves, so a
     * file present on one side only is a difference of its own.
     */
    const previous = layout('1.4.4', BASE)
    const current = layout('1.4.5', BASE)
    rmSync(join(current, 'dist', 'index.d.cts'))
    const run = spawnSync('node', [SCRIPT, '--against', previous], {
      cwd: current,
      encoding: 'utf8'
    })
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('index.d.cts')
    expect(run.stdout).toContain('removed')
  })

  it('picks the highest stable version below the current one', () => {
    /*
     * Scenario: the registry lists prereleases and versions above the one being released
     * (a re-run after a later release). Only the highest stable version below counts.
     */
    const run = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { previousVersion } from ${JSON.stringify(`file://${SCRIPT}`)}
console.log(previousVersion(['1.4.3','1.4.4','1.4.5-rc.1','1.4.5','1.5.0','1.4.10'], '1.4.5'))
console.log(String(previousVersion(['1.0.0'], '1.0.0')))`
      ],
      { encoding: 'utf8' }
    )
    expect(run.stdout.trim().split('\n')).toEqual(['1.4.4', 'undefined'])
  })
})
