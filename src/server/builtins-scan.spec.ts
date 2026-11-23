/**
 * Verifies, in both directions, that the table of guarded built-ins matches the code that reads them:
 * every built-in member a call reaches in the files that decide what is hidden is in the table, and
 * every member in the table is reached by those files or is named below with the reason it is there. A
 * built-in added to one of the files without a place in the table fails here, and so does an entry
 * left behind when the call is removed.
 *
 * Layer: server, tests. Reads the source of the files with the TypeScript parser; runs nothing of them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

import { GUARDED_BUILTINS } from './utils/captured-builtins.util'

const FILES = [
  'utils/fold-key.util.ts',
  'utils/normalize-url.util.ts',
  'utils/matches-exclude-path.util.ts',
  'utils/sanitize-error.util.ts',
  'pino-factory.ts'
]

/** Globals whose members are called as `Receiver.member(...)`: the holder is the global itself. */
const STATIC_HOLDERS: Readonly<Record<string, object>> = {
  Array,
  Math,
  Number,
  Object,
  Reflect,
  String
}

/**
 * Members a call in those files reaches that belong to the library or to an object that is not a
 * built-in, each with why it is not in the table.
 */
const NOT_BUILT_INS: Readonly<Record<string, string>> = {
  walk: 'a callback the caller of the redaction passes',
  censorName: 'a callback the caller of the redaction passes',
  hasToJson: 'a callback the caller of the redaction passes',
  registerStream: 'a method of the destination health the factory owns',
  recordTruncation: 'a method of the destination health the factory owns',
  multistream:
    'Pino fans the record out; it runs after the redaction, and is checked as a whole by shift and forEach',
  stringify: 'the timestamp of the record, not a name to hide',
  timestamp: 'the timestamp function of the host, which is a callback and not a built-in',
  call: 'Function.prototype.call, bound when the module loaded where it is read for a secret',
  bind: 'Function.prototype.bind, run when the module loaded',
  hasOwnProperty: 'not called; listed so that an addition is seen'
}

/** Members of the table no call of those files reaches, each with why it is guarded. */
const GUARDED_FOR_OTHER_READERS: Readonly<Record<string, string>> = {
  shift: 'Pino reads it for each log call',
  forEach: 'Pino reads it when it builds its fan-out',
  values: 'read for the iteration of a set the error code walks',
  create: 'read by the clone of an error the stack code makes',
  getOwnPropertyDescriptors: 'read by the clone of an error the stack code makes',
  getPrototypeOf: 'read by the clone of an error the stack code makes',
  defineProperty: 'read by the clone of an error the stack code makes',
  deleteProperty: 'read by the clone of an error the stack code makes',
  ownKeys: 'read by the clone of an error the stack code makes',
  normalize: 'called through the function captured when the module loaded',
  toLowerCase: 'called through the function captured when the module loaded',
  exec: 'called through the function captured when the module loaded',
  next: 'read by every spread and for...of, through the iterator of the value',
  get: 'Reflect.get, read by the walk of a record and the clone of an error'
}

interface Call {
  readonly receiver: string
  readonly member: string
  readonly file: string
}

function callsOf(file: string): Call[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const found: Call[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      found.push({
        receiver: node.expression.expression.getText(source),
        member: node.expression.name.text,
        file
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Where a file iterates by syntax: a `for...of`, a spread, or an array destructuring. */
function iterationsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const isDestructuring =
      ts.isArrayBindingPattern(node) ||
      (ts.isArrayLiteralExpression(node) &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    if (ts.isForOfStatement(node) || ts.isSpreadElement(node) || isDestructuring) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      found.push(`${file}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const CALLS = FILES.flatMap(callsOf)
const ITERATIONS = FILES.flatMap(iterationsOf)
const GUARDED_NAMES = new Set(
  GUARDED_BUILTINS.flatMap(([, members]) => members.filter((member) => typeof member === 'string'))
)

function isGuarded(holder: object | undefined, member: string): boolean {
  return GUARDED_BUILTINS.some(
    ([guarded, members]) => (holder === undefined || guarded === holder) && members.includes(member)
  )
}

describe('the table of guarded built-ins', () => {
  /**
   * Given every call of the form `receiver.member(...)` in the files that decide what is hidden
   * When the member is looked up in the table, as a member of the global named by the receiver for a
   * static call, and by its name for a method on a value
   * Then it is guarded, or is named as not being a built-in
   */
  it('has every built-in member the files call', () => {
    const missing = CALLS.filter((call) => {
      const holder = STATIC_HOLDERS[call.receiver]
      if (holder !== undefined) return !isGuarded(holder, call.member)
      return !isGuarded(undefined, call.member) && !(call.member in NOT_BUILT_INS)
    }).map((call) => `${call.file}: ${call.receiver}.${call.member}`)

    expect(missing).toEqual([])
  })

  /**
   * Given every member in the table
   * When the calls of those files are read
   * Then it is called there, or is named as read by Pino or by the code beside them
   */
  it('has no member that nothing reads', () => {
    const called = new Set(CALLS.map((call) => call.member))

    const unused = [...GUARDED_NAMES].filter(
      (member) =>
        !called.has(member as string) && !((member as string) in GUARDED_FOR_OTHER_READERS)
    )

    expect(unused).toEqual([])
  })

  /**
   * Given the iteration of a spread or `for...of`, which reads the iterator of the value and the `next`
   * of its iterator
   * When the table is read
   * Then the iterators of an array, a string, a map and a set, and the `next` of each, are in it
   */
  it('guards the iterators and the next of each', () => {
    const symbols = GUARDED_BUILTINS.filter(([, members]) => members.includes(Symbol.iterator))
    const nexts = GUARDED_BUILTINS.filter(([, members]) => members.includes('next'))

    expect(symbols.map(([holder]) => holder)).toEqual(
      expect.arrayContaining([Array.prototype, String.prototype, Map.prototype, Set.prototype])
    )
    expect(nexts).toHaveLength(5)
  })

  /**
   * Given every `for...of`, spread and array destructuring in the files that decide what is hidden
   * When the table is read
   * Then each kind of iterator they can reach, and the `next` of it, is guarded, and a file that does
   *   not iterate by syntax at all leaves the rows to be justified as read by Pino
   */
  it('guards the iterator of every syntax iteration the files use', () => {
    const guardedIterators = GUARDED_BUILTINS.filter(([, members]) =>
      members.includes(Symbol.iterator)
    ).length

    if (ITERATIONS.length > 0) expect(guardedIterators).toBeGreaterThanOrEqual(4)
    else expect(GUARDED_FOR_OTHER_READERS.next).toBeDefined()
    expect(ITERATIONS.every((site) => /:\d+$/.test(site))).toBe(true)
  })

  it('names a reason for every member it leaves to another reader', () => {
    for (const reason of Object.values({ ...NOT_BUILT_INS, ...GUARDED_FOR_OTHER_READERS })) {
      expect(reason.length).toBeGreaterThan(10)
    }
  })
})
