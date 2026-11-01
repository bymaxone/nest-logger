/**
 * Pins `scripts/check-api-surface.mjs`, the gate for the built public declarations. A
 * difference from the previous published version, at any bump level, fails unless the CHANGELOG
 * section of the released version holds the "Apply to a derived backend" note.
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
function layout(version: string, declarations: string, changelog?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'api-surface-spec-'))
  roots.push(root)
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-lib', version }))
  writeFileSync(join(root, 'dist', 'index.d.ts'), declarations)
  writeFileSync(join(root, 'dist', 'index.d.cts'), declarations)
  if (changelog !== undefined) writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  return root
}

/** Runs the gate for `after` as 1.4.5 against `before` published as 1.4.4. */
function checkPair(before: string, after: string): Result {
  const previous = layout('1.4.4', before)
  const current = layout('1.4.5', after)
  const run = spawnSync('node', [SCRIPT, '--against', previous], { cwd: current, encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

/** Runs the gate for `declarations` as version `next`, against `BASE` published as 1.4.4. */
function check(declarations: string, next = '1.4.5', changelog?: string): Result {
  const previous = layout('1.4.4', BASE)
  const current = layout(next, declarations, changelog)
  const run = spawnSync('node', [SCRIPT, '--against', previous], { cwd: current, encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('check-api-surface', () => {
  describe('a change to the public declarations with no CHANGELOG note fails', () => {
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
       * alters the type surface of a published release. With no CHANGELOG note the gate must
       * exit 1, print the differing file, and say the note is required.
       */
      const { status, output } = check(declarations)
      expect(status).toBe(1)
      expect(output).toContain('index.d.ts')
      expect(output).toContain('Apply to a derived backend')
    })
  })

  describe('a release that changes no declaration passes', () => {
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

  describe('the compatibility note', () => {
    const ADDED = BASE.replace(
      'info(message: string): void;',
      'info(message: string): void;\n    warn(message: string): void;'
    )
    const section = (version: string, body: string): string =>
      `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-11-02\n\n### Added\n\n- A method.\n\n${body}\n`

    it.each([
      [
        'a heading',
        '#### Apply to a derived backend\n\nCall `warn` where you used to wrap `info`.'
      ],
      ['a heading with an emoji', '### ⚠️ Apply to a derived backend\n\nNew method.'],
      ['a bold lead-in', '- **Apply to a derived backend:** a new method.'],
      ['the older consumer spelling', '#### Apply to a consumer\n\nA new method.'],
      ['any letter case', '#### APPLY TO A DERIVED BACKEND\n\nA new method.'],
      ['a placeholder under the heading', '#### Apply to a derived backend\n\nNothing to apply.']
    ])('passes a changed declaration whose section carries the note as %s', (_name, note) => {
      /*
       * Scenario: the version number carries no compatibility information in this family, so a
       * declaration change is allowed in any release that says so in its own CHANGELOG
       * section. Every spelling the sibling changelogs use must be recognised.
       */
      const { status, output } = check(ADDED, '1.4.5', section('1.4.5', note))
      expect(status).toBe(0)
      expect(output).toContain('+     warn(message: string): void;')
      expect(output).toContain('carries the "Apply to a derived backend" note')
    })

    it.each(['1.4.5', '1.5.0', '2.0.0'])(
      'fails a changed declaration with no note in a %s release and names it',
      (version) => {
        /*
         * Scenario: a declaration change needs the note whatever the bump level. A patch, a
         * minor and a major that change the declarations without it all fail, and the message
         * names the declaration that changed so the author knows what to describe.
         */
        const { status, output } = check(ADDED, version, section(version, 'No migration text.'))
        expect(status).toBe(1)
        expect(output).toContain('Logger')
        expect(output).toContain('has no "Apply to a derived backend" note')
      }
    )

    it('does not count the note when it sits under another version', () => {
      /*
       * Scenario: the note must be in the section of the version being released. One under
       * the previous version's heading, or under Unreleased, belongs to another release.
       */
      const changelog = `${section('1.4.5', 'No migration text.')}\n## [1.4.4] - 2026-10-31\n\n#### Apply to a derived backend\n\nOld note.\n`
      expect(check(ADDED, '1.4.5', changelog).status).toBe(1)
    })

    it('does not take the section of a version that merely starts the same', () => {
      /*
       * Scenario: 1.4.50 is not 1.4.5. The heading is matched through its closing bracket,
       * so the section of a longer version number never stands in for the one released.
       */
      const { status, output } = check(
        ADDED,
        '1.4.5',
        section('1.4.50', '#### Apply to a derived backend\n\nx')
      )
      expect(status).toBe(1)
      expect(output).toContain('does not exist')
    })

    it('fails when the CHANGELOG has no section for the version or no file at all', () => {
      /*
       * Scenario: a declaration change needs a section to carry its note, so a missing
       * section and a missing CHANGELOG.md both fail, and say that the section does not exist.
       */
      const noSection = check(
        ADDED,
        '1.4.5',
        section('1.4.4', '#### Apply to a derived backend\n\nx')
      )
      expect(noSection.status).toBe(1)
      expect(noSection.output).toContain('does not exist')
      expect(check(ADDED, '1.4.5').status).toBe(1)
    })

    it('passes an unchanged declaration with no CHANGELOG note or file', () => {
      /*
       * Scenario: the note is required only when something changed, so a release with the
       * same declarations passes with a bare CHANGELOG or none.
       */
      expect(check(BASE, '1.4.5').status).toBe(0)
      expect(check(BASE, '1.4.5', section('1.4.5', 'Nothing.')).status).toBe(0)
    })
  })

  it('fails a release that only reorders its reference directives', () => {
    /*
     * Scenario: the files a declaration file references are pulled into the consumer's
     * compilation in order, and the order can decide how overloads and merged declarations
     * resolve. Swapping two directives, of the same kind or of different kinds, is an API
     * change a gate that sorted them would report as no difference.
     */
    const path = '/// <reference path="./a.d.ts" />'
    const types = '/// <reference types="node" />'
    const otherPath = '/// <reference path="./b.d.ts" />'
    const swaps: [string[], string[]][] = [
      [
        [path, otherPath],
        [otherPath, path]
      ],
      [
        [types, path],
        [path, types]
      ]
    ]
    for (const [before, after] of swaps) {
      const previous = layout('1.4.4', `${before.join('\n')}\n${BASE}`)
      const current = layout('1.4.5', `${after.join('\n')}\n${BASE}`)
      const run = spawnSync('node', [SCRIPT, '--against', previous], {
        cwd: current,
        encoding: 'utf8'
      })
      expect(run.status).toBe(1)
    }
  })

  describe('reference directives', () => {
    const path = '/// <reference path="./ambient.d.ts" />'
    const types = '/// <reference types="node" />'

    it.each([
      ['a removed directive', `${path}\n${BASE}`, BASE],
      ['an added amd-module directive', BASE, `/// <amd-module name="lib" />\n${BASE}`],
      ['an added amd-dependency directive', BASE, `/// <amd-dependency path="dep" />\n${BASE}`],
      [
        'a changed directive attribute',
        `${types}\n${BASE}`,
        `/// <reference types="node" resolution-mode="import" />\n${BASE}`
      ],
      [
        'a changed space inside an attribute value',
        `/// <reference path="./a  b.d.ts" />\n${BASE}`,
        `/// <reference path="./a b.d.ts" />\n${BASE}`
      ],
      [
        'an apostrophe turned into a quote inside an attribute value',
        `/// <reference path="./it's.d.ts" />\n${BASE}`,
        `/// <reference path='./it"s.d.ts' />\n${BASE}`
      ],
      [
        'a changed directive that does not parse',
        `/// <unknown thing here\n${BASE}`,
        `/// <unknown thing there\n${BASE}`
      ],
      [
        'a changed directive target',
        `${path}\n${BASE}`,
        `/// <reference path="./other.d.ts" />\n${BASE}`
      ]
    ])('fails a release with %s', (_name, before, after) => {
      /*
       * Scenario: every triple-slash directive decides what the file type-checks against,
       * whatever its kind or attributes, so each of these changes the consumer's view
       * while no statement of the file changes.
       */
      expect(checkPair(before, after).status).toBe(1)
    })

    it('ignores the quote style and spacing of a directive', () => {
      /*
       * Scenario: `path='x'` and `path="x"` with other spacing are the same directive, so
       * re-emitting one in another style must not fail a release.
       */
      const restyled = "///   <reference   path='./ambient.d.ts'   />"
      expect(checkPair(`${path}\n${BASE}`, `${restyled}\n${BASE}`).status).toBe(0)
    })

    it('ignores a plain comment above the directives', () => {
      /*
       * Scenario: a plain `//` comment is not a directive, so adding one above them is
       * documentation and must not fail a release.
       */
      expect(checkPair(`${path}\n${BASE}`, `// bundled output\n${path}\n${BASE}`).status).toBe(0)
    })
  })

  it.each([
    [
      'dropping `export {}`',
      'interface Options {\n    value: string;\n}\nexport {};\n',
      'interface Options {\n    value: string;\n}\n'
    ],
    [
      'adding `export {}`',
      'interface Options {\n    value: string;\n}\n',
      'interface Options {\n    value: string;\n}\nexport {};\n'
    ]
  ])(
    'fails a release %s, which turns the file from a module into a script or back',
    (_name, before, after) => {
      /*
       * Scenario: with no import or export a declaration file is a script and its
       * declarations are global; `export {}` makes it a module. Flattening the export lists
       * leaves nothing behind for that marker, so the normalized text records the file's kind
       * and the swap is a difference.
       */
      expect(checkPair(before, after).status).toBe(1)
    }
  )

  it.each([
    [
      'one export whose name holds a comma and a keyword',
      'declare const x: 1;\nexport { x as "a, x as b" };\n',
      'declare const x: 1;\nexport { x as a, x as b };\n'
    ],
    [
      'one export whose name holds a line break',
      'declare const x: 1;\nexport { x as "a\\nx as b" };\n',
      'declare const x: 1;\nexport { x as a, x as b };\n'
    ],
    [
      'an export renamed to another exported name',
      'declare const x: 1;\nexport { x as a };\n',
      'declare const x: 1;\nexport { x as b };\n'
    ],
    [
      'an export of another declaration under the same exported name',
      'declare const x: 1;\ndeclare const y: 2;\nexport { x as a };\n',
      'declare const x: 1;\ndeclare const y: 2;\nexport { y as a };\n'
    ],
    [
      'an alias named like a type-only specifier',
      'declare const x: 1;\nexport { x as "type y" };\n',
      'declare const x: 1;\nexport { type x as y };\n'
    ]
  ])('fails a release that turns %s into different exports', (_name, before, after) => {
    /*
     * Scenario: the flattened export records must not depend on how a name is spelled. A
     * string-literal export name can hold the characters a joined list would use as its
     * delimiters, so each record is encoded structurally and two different export sets
     * never normalize to the same text.
     */
    expect(checkPair(before, after).status).toBe(1)
  })

  it('treats an export written with and without a redundant alias as the same', () => {
    /*
     * Scenario: `export { x as x }` and `export { x }` and a string-literal name that is a
     * plain identifier export the same name, so re-emitting one as the other is no change.
     */
    const before = 'declare const x: 1;\nexport { x };\n'
    expect(checkPair(before, 'declare const x: 1;\nexport { x as x };\n').status).toBe(0)
    expect(checkPair(before, 'declare const x: 1;\nexport { x as "x" };\n').status).toBe(0)
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
