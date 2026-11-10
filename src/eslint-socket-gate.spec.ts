/**
 * Pins the lint gate that keeps a unit spec under `src/` from opening a socket: `supertest`, in
 * every way a spec loads it, and a call to `listen` or `createNestApplication`. The repository's
 * own ESLint runs on a text as if it were the file at a given path, one line per form, so a case
 * reads which lines the gate reports and for which paths.
 *
 * Layer: repository tooling, tests. It imports nothing from `src/`; ESLint runs as a child
 * process, because its configuration is an ES module that Jest cannot load in-process.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const ESLINT = resolve(ROOT, 'node_modules', '.bin', 'eslint')
const RESTRICTED = new Set(['no-restricted-imports', 'no-restricted-syntax'])
const SPEC = 'src/server/gate-probe.spec.ts'

interface Message {
  readonly ruleId: string | null
  readonly line: number
}

/** The 1-based lines of `lines`, joined as the text of the file at `filePath`, that the gate reports. */
function reportedLines(lines: readonly string[], filePath: string): number[] {
  const run = spawnSync(
    ESLINT,
    ['--stdin', '--stdin-filename', filePath, '--format', 'json', '--no-warn-ignored'],
    { cwd: ROOT, input: lines.join('\n'), encoding: 'utf8' }
  )
  const [result] = JSON.parse(run.stdout) as [{ messages: Message[] }]
  const reported = result.messages
    .filter((message) => message.ruleId !== null && RESTRICTED.has(message.ruleId))
    .map((message) => message.line)
  return [...new Set(reported)].sort((a, b) => a - b)
}

const FORBIDDEN = [
  "import request from 'supertest'",
  "import { agent } from 'supertest'",
  "import type { Test } from 'supertest'",
  "import { agent as other } from 'supertest/lib/agent'",
  "export { default } from 'supertest'",
  "const required = require('supertest')",
  "const load = () => import('supertest')",
  'const a = async (app: any) => app.listen(0)',
  'const b = async (app: any) => app?.listen(0)',
  'const c = (moduleRef: any) => moduleRef.createNestApplication()'
]

const ALLOWED = [
  "import { join } from 'node:path'",
  "const { relative } = require('node:path')",
  'const list = [1].map((n) => n)'
]

describe('the gate that keeps a unit spec from opening a socket', () => {
  it('fails a unit spec under src on every way of loading supertest or opening a server', () => {
    const lines = reportedLines(FORBIDDEN, SPEC)

    expect(lines).toEqual(FORBIDDEN.map((_text, index) => index + 1))
  })

  it('leaves a unit spec under src alone when it does none of that', () => {
    expect(reportedLines(ALLOWED, SPEC)).toEqual([])
  })

  it.each([
    ['an e2e spec', 'test/e2e/probe.e2e-spec.ts'],
    ['a script', 'scripts/probe.mjs'],
    ['a file under src that is not a spec', 'src/server/probe.ts']
  ])('does not apply to %s', (_name, filePath) => {
    expect(
      reportedLines(["import request from 'supertest'", 'const a = b.listen(0)'], filePath)
    ).toEqual([])
  })

  it('exempts the specs that still open a socket, and no other', () => {
    const code = ["import request from 'supertest'"]

    expect(reportedLines(code, 'src/server/middlewares/apply-access-log.spec.ts')).toEqual([])
    expect(reportedLines(code, 'src/server/middlewares/apply-access-log.other.spec.ts')).toEqual([
      1
    ])
  })
})
