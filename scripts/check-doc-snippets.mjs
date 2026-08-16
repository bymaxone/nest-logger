/**
 * Purpose: fail when a TypeScript snippet in `docs/` uses one of this package's own
 * symbols without importing or declaring it, or calls `this.something` that the class
 * shown in the same snippet does not define.
 *
 * Layer: repository tooling. Nothing here ships — `scripts/` is outside `files`.
 *
 * Why it exists: this defect class recurred across four review rounds of the same
 * pull request — a snippet referencing `safeMinLevel`, `LOGGER_OPTIONS_TOKEN`,
 * `PREVIEW_LENGTH` or `this.reportShutdownFailure` with nothing to resolve them.
 * Reviewing prose by eye does not catch it; parsing does.
 *
 * How it decides. Two questions, both answered from the syntax tree rather than from
 * a regular expression, because a name inside a comment or a string is a MENTION and
 * only a name in an expression is a USE:
 *
 *   1. Does the snippet use a symbol this package declares in `src/` — an export or a
 *      module-level constant — while neither importing nor declaring it?
 *   2. Does it read `this.member` while declaring the enclosing class itself?
 *
 * Question 2 is asked only of snippets that show a complete class. A snippet that is
 * openly an excerpt of one method has no class to check against, and demanding one
 * would push every excerpt toward being a full file.
 *
 * Deliberately NOT checked: a free local like `health` in an excerpt whose scope the
 * prose introduces. Flagging those means flagging every excerpt variable, and the
 * noise would retire the check. That case stays a matter of writing the prose well.
 *
 * The baseline. The planning documents carry 66 of these occurrences from before the
 * check existed — 37 distinct file-and-symbol pairs, since one missing import usually
 * shows up in several snippets of the same document. Fixing all of them is not the same
 * job as stopping new ones, so they are recorded in
 * `doc-snippets-baseline.json`, which this script can only ever shrink: a
 * finding outside it fails, and an entry inside it that no longer reproduces ALSO
 * fails, so a fixed snippet cannot leave a stale line behind. Regenerate with
 * `--write-baseline` — a command to run when you fixed something, never to make a new
 * finding go away.
 *
 * Baseline entries are keyed by file and symbol, not by line, so editing prose above a
 * snippet does not churn the file. The cost of that choice is one real gap: a NEW
 * snippet in an already-listed file that omits the SAME symbol is absorbed by the
 * existing entry. Anything else — a new symbol, a new file, any `this.member` — fails.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const DOCS = join(ROOT, 'docs')

/** Recursively list files under `dir` that the caller's `filter` accepts. */
function walk(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, filter))
    else if (filter(full)) out.push(full)
  }
  return out
}

/**
 * Every name this package declares at module level in `src/` — exported or not.
 * A snippet may legitimately use any of them, but only after saying where it came
 * from, and these are the only names whose origin this script can know.
 */
function internalSymbols() {
  const names = new Set()
  const files = walk(SRC, (f) => extname(f) === '.ts' && !f.includes('.spec.'))
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text)
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text)
      }
    }
  }
  return names
}

/** Extract every ```typescript block, with the line its fence opens on. */
function snippetsOf(markdown) {
  const blocks = []
  const lines = markdown.split('\n')
  let start = -1
  let buffer = []
  for (const [index, line] of lines.entries()) {
    // Blockquoted snippets (`> ```typescript`) are code too — the task documents
    // quote most of theirs, and skipping them hid three of the reported defects.
    const bare = line.replace(/^>\s?/, '')
    if (start === -1) {
      if (/^```typescript\s*$/.test(bare)) {
        start = index + 1
        buffer = []
      }
    } else if (/^```\s*$/.test(bare)) {
      blocks.push({ line: start, code: buffer.join('\n') })
      start = -1
    } else {
      buffer.push(bare)
    }
  }
  return blocks
}

/** Names the snippet itself introduces: imports, declarations, parameters, bindings. */
function declaredIn(source) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)
    } else if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeParameterDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** Names the snippet reads as values or types — never a property, never a comment. */
function usedIn(source) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node)
      // A shorthand `{ safeMinLevel }` names the property AND reads the variable, so
      // it is a use — treating it as a declaration name would hide exactly the kind of
      // reference this script exists to find.
      const isOwnDeclarationName =
        parent &&
        parent.name === node &&
        !isPropertyName &&
        !ts.isShorthandPropertyAssignment(parent)
      if (!isPropertyName && !isOwnDeclarationName) names.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** `this.x` reads, paired with the members every class in the snippet declares. */
function thisUsage(source) {
  const used = new Set()
  const declared = new Set()
  let sawClass = false
  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      sawClass = true
      for (const member of node.members) {
        if (member.name && ts.isIdentifier(member.name)) declared.add(member.name.text)
        // Parameter properties: `constructor(private readonly logger: X)`.
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (parameter.modifiers?.length && ts.isIdentifier(parameter.name)) {
              declared.add(parameter.name.text)
            }
          }
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(node.name)
    ) {
      used.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { used, declared, sawClass }
}

const symbols = internalSymbols()
const findings = []
/** `file::symbol` for every finding, so the baseline survives line shifts. */
const keys = new Set()

for (const file of walk(DOCS, (f) => extname(f) === '.md')) {
  const markdown = readFileSync(file, 'utf8')
  for (const { line, code } of snippetsOf(markdown)) {
    // The name is a LABEL, not a path — `createSourceFile` parses the string it is
    // given and never touches the filesystem, so no snippet is written to disk.
    const source = ts.createSourceFile(`${file}:${line}.ts`, code, ts.ScriptTarget.Latest, true)
    const declared = declaredIn(source)
    const relative = file.slice(ROOT.length)

    for (const name of usedIn(source)) {
      if (symbols.has(name) && !declared.has(name)) {
        findings.push({
          key: `${relative}::${name}`,
          text: `${relative}:${line} — uses \`${name}\` without importing or declaring it`
        })
      }
    }

    const { used, declared: members, sawClass } = thisUsage(source)
    if (sawClass) {
      for (const member of used) {
        if (!members.has(member)) {
          findings.push({
            key: `${relative}::this.${member}`,
            text: `${relative}:${line} — calls \`this.${member}\`, which the class shown does not declare`
          })
        }
      }
    }
  }
}

for (const finding of findings) keys.add(finding.key)

const baselinePath = join(ROOT, 'scripts', 'doc-snippets-baseline.json')

if (process.argv.includes('--write-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify([...keys].sort(), null, 2)}\n`)
  console.log(`Baseline written: ${keys.size} known findings.`)
  process.exit(0)
}

let baseline = []
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch {
  console.error(`Missing or unreadable baseline: ${baselinePath}`)
  console.error('Generate it with: node scripts/check-doc-snippets.mjs --write-baseline')
  process.exit(1)
}

const known = new Set(baseline)
const introduced = findings.filter((finding) => !known.has(finding.key))
const fixed = baseline.filter((key) => !keys.has(key))

if (introduced.length > 0) {
  console.error(
    `Documentation snippets reference symbols that are not there (${introduced.length}):\n`
  )
  for (const finding of introduced.map((f) => f.text).sort()) console.error(`  ${finding}`)
  console.error('\nAdd the import, declare the symbol, or show the member the snippet calls.')
  process.exit(1)
}

if (fixed.length > 0) {
  console.error(`The baseline lists ${fixed.length} finding(s) that no longer reproduce:\n`)
  for (const key of fixed.sort()) console.error(`  ${key}`)
  console.error('\nThey were fixed — drop them so the baseline keeps shrinking:')
  console.error('  node scripts/check-doc-snippets.mjs --write-baseline')
  process.exit(1)
}

console.log(
  `✔ No documentation snippet references a missing symbol (${known.size} pre-existing, none new).`
)
