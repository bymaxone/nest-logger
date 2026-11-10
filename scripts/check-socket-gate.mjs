/**
 * @fileoverview Socket-gate check — proves the lint rule that keeps a unit spec under `src/` from
 * opening a socket reports every way a spec can load `supertest` or start a server, and only
 * there.
 * @layer scripts
 *
 * The rule is `no-restricted-imports` plus `no-restricted-syntax` in `eslint.config.mjs`. A rule
 * that is configured is not a rule that fires: `no-restricted-imports` sees import declarations
 * and re-exports only, so a `require` and a dynamic `import()` need selectors of their own. This
 * script runs the repository's own ESLint on a text as if it were the file at a given path, one
 * form per line, and fails when a form is not reported, when an allowed text is, or when the gate
 * applies where it should not.
 *
 * Usage: node scripts/check-socket-gate.mjs [--config <eslint config file>]
 * `pnpm lint` runs it after ESLint.
 */
import { resolve } from 'node:path'
import { argv, exit } from 'node:process'

import { ESLint } from 'eslint'

const RESTRICTED = new Set(['no-restricted-imports', 'no-restricted-syntax'])
const SPEC = 'src/server/gate-probe.spec.ts'

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

const ELSEWHERE = [
  'test/e2e/probe.e2e-spec.ts',
  'scripts/probe.mjs',
  'src/server/probe.ts',
  'src/server/middlewares/apply-access-log.spec.ts'
]

const configIndex = argv.indexOf('--config')
const configFile = configIndex === -1 ? 'eslint.config.mjs' : (argv[configIndex + 1] ?? '')
const eslint = new ESLint({ overrideConfigFile: resolve(configFile) })

/**
 * The 1-based lines of `lines`, taken as the text of the file at `filePath`, that the gate reports.
 *
 * @param {readonly string[]} lines - One form per line.
 * @param {string} filePath - The path the text is linted as.
 * @returns {Promise<number[]>} The reported lines, ascending.
 */
async function reportedLines(lines, filePath) {
  const [result] = await eslint.lintText(lines.join('\n'), { filePath })
  const reported = (result?.messages ?? [])
    .filter((message) => RESTRICTED.has(message.ruleId ?? ''))
    .map((message) => message.line)
  return [...new Set(reported)].sort((a, b) => a - b)
}

const problems = []

const forbidden = await reportedLines(FORBIDDEN, SPEC)
FORBIDDEN.forEach((text, index) => {
  if (!forbidden.includes(index + 1)) problems.push(`not reported in ${SPEC}: ${text}`)
})

for (const line of await reportedLines(ALLOWED, SPEC)) {
  problems.push(`reported in ${SPEC} though allowed: ${ALLOWED[line - 1]}`)
}

for (const filePath of ELSEWHERE) {
  const lines = await reportedLines(
    ["import request from 'supertest'", 'const a = b.listen(0)'],
    filePath
  )
  if (lines.length > 0) problems.push(`reported in ${filePath}, where the gate does not apply`)
}

const other = await reportedLines(["import request from 'supertest'"], 'src/server/other.spec.ts')
if (other.length !== 1) problems.push('a new unit spec under src is not reported')

if (problems.length > 0) {
  console.error(`✖ The socket gate in ${configFile} does not behave as stated:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  exit(1)
}
console.log('The socket gate reports every form it names, and only in unit specs under src.')
