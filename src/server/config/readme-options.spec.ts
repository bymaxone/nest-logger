import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Test } from '@nestjs/testing'

import type { ServiceMetadata } from '../../shared/types/service-metadata.type'
import { LOGGER_DESTINATIONS_TOKEN } from '../constants/injection-tokens.constants'
import { DefaultStdoutDestination } from '../destinations/default-stdout.destination'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { BymaxLoggerModule } from '../logger.module'
import { resolveServiceMetadata } from '../utils/resolve-resource.util'
import { applyDefaults } from './default-options'

/**
 * The README is published to npm and is where the options are read. `check:published`
 * compiles its code fences, but nothing reads its tables, which is where a stale default
 * hides. These cases parse the three option tables and hold every row against the
 * defaults the module really applies, and hold the tables against the option set.
 */
const README = readFileSync(join(__dirname, '..', '..', '..', 'README.md'), 'utf-8')

const service = { name: 'app', version: '1.0.0' } as const

/**
 * Every field `ServiceMetadata` has. `Required<>` makes a field added to the interface a
 * compile error here, so the `service.*` rows cannot silently fall behind it.
 */
const everyServiceField: Required<ServiceMetadata> = {
  name: 'app',
  version: '1.0.0',
  namespace: 'payments',
  instanceId: 'pod-1',
  environment: 'production'
}
const baseOptions: BymaxLoggerModuleOptions = { service }

/** Stands in for an escaped pipe while a row is split; a private-use code point never occurs in the README. */
const ESCAPED_PIPE = '\uE000'

/** Split a Markdown table row into cells, keeping an escaped pipe (`\|`) inside its cell. */
function splitRow(line: string): string[] {
  return line
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.replace(new RegExp(ESCAPED_PIPE, 'g'), '|').trim())
}

/** Strip the backticks around a documented code span. */
function unwrap(cell: string): string {
  const match = /^`(.*)`$/.exec(cell)
  return match?.[1] ?? cell
}

/**
 * Option name to its Default cell, for the table under the given heading of a Markdown
 * document. A repeated option name throws: a Map would keep the last row and hide the first.
 */
function parseOptionTable(markdown: string, heading: string): ReadonlyMap<string, string> {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) {
    throw new Error(`README has no "${heading}" heading`)
  }
  const rows = new Map<string, string>()
  let tableLine = 0
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (tableLine > 0) {
        break
      }
      continue
    }
    tableLine += 1
    // Lines one and two are the header and the separator.
    if (tableLine > 2) {
      const [name, , defaultCell] = splitRow(line)
      if (name === undefined || defaultCell === undefined) {
        throw new Error(`Malformed row under "${heading}": ${line}`)
      }
      const option = unwrap(name)
      if (rows.has(option)) {
        throw new Error(`Duplicate row for "${option}" under "${heading}"`)
      }
      rows.set(option, defaultCell)
    }
  }
  return rows
}

/** The same, for the published README. */
function readOptionTable(heading: string): ReadonlyMap<string, string> {
  return parseOptionTable(README, heading)
}

/** The value a plain-literal Default cell documents, or `undefined` when it is not one. */
function literalOf(cell: string): { readonly value: unknown } | undefined {
  const code = unwrap(cell)
  const quoted = /^'(.*)'$/.exec(code)
  if (quoted?.[1] !== undefined) {
    return { value: quoted[1] }
  }
  if (code === 'true' || code === 'false') {
    return { value: code === 'true' }
  }
  if (/^\d+$/.test(code)) {
    return { value: Number(code) }
  }
  if (code === '[]') {
    return { value: [] }
  }
  if (code === '{}') {
    return { value: {} }
  }
  return undefined
}

const TOP_LEVEL = readOptionTable('### Top-level options')
const HTTP = readOptionTable('### `http` options')
const OTEL = readOptionTable('### `otel` options')

/** The documented cell for a default that is a behaviour, not a literal. */
const LEVEL_CELL = "`'info'` when `NODE_ENV=production`, else `'debug'`"
const EXCLUDE_PATHS_CELL = '`[/^\\/health$/, /^\\/metrics$/]`'
const TIMESTAMP_CELL = '`() => new Date().toISOString()`'
const DESTINATIONS_CELL = '`[new DefaultStdoutDestination()]`'

describe('README option tables', () => {
  const originalNodeEnv = process.env['NODE_ENV']

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV']
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  const resolved = applyDefaults(baseOptions)

  describe('defaults', () => {
    const literalRows = [...TOP_LEVEL].filter(
      ([name]) =>
        !name.startsWith('service.') && !['level', 'timestamp', 'destinations'].includes(name)
    )

    it.each(literalRows)(
      /*
       * Each top-level row's Default cell is a literal the module applies verbatim. A
       * row left behind by a changed default fails here, naming the option.
       */
      'documents the applied default of `%s`',
      (name, cell) => {
        const literal = literalOf(cell)
        expect(literal).toBeDefined()
        expect((resolved as unknown as Record<string, unknown>)[name]).toEqual(literal?.value)
      }
    )

    it.each([...HTTP])(
      /*
       * The http table is held to the same standard, except the exclusion list, which
       * is a list of regular expressions rather than a plain literal.
       */
      'documents the applied default of `%s`',
      (name, cell) => {
        const key = name.replace(/^http\./, '') as keyof typeof resolved.http
        if (name === 'http.excludePaths') {
          expect(cell).toBe(EXCLUDE_PATHS_CELL)
          expect(`\`[${resolved.http.excludePaths.map(String).join(', ')}]\``).toBe(cell)
          return
        }
        expect(resolved.http[key]).toEqual(literalOf(cell)?.value)
      }
    )

    it.each([...OTEL])(
      /*
       * The otel table is all literals. The three field-name defaults hold under the
       * default `fieldFormat`; `snake_case` derives different ones.
       */
      'documents the applied default of `%s`',
      (name, cell) => {
        const key = name.replace(/^otel\./, '') as keyof typeof resolved.otel
        expect(resolved.otel[key]).toEqual(literalOf(cell)?.value)
      }
    )

    it(/*
     * `level` has no single default: production is `info` and everything else is
     * `debug`. The cell says so, and both halves are exercised.
     */
    'documents the NODE_ENV-dependent default of `level`', () => {
      expect(TOP_LEVEL.get('level')).toBe(LEVEL_CELL)
      process.env['NODE_ENV'] = 'production'
      expect(applyDefaults(baseOptions).level).toBe('info')
      process.env['NODE_ENV'] = 'development'
      expect(applyDefaults(baseOptions).level).toBe('debug')
    })

    it(/*
     * The default clock is documented as the ISO-8601 instant of the call; the cell is
     * pinned and the function is called.
     */
    'documents the default `timestamp` function', () => {
      expect(TOP_LEVEL.get('timestamp')).toBe(TIMESTAMP_CELL)
      expect(resolved.timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it(/*
     * `destinations` resolves to an empty list in the options and to the stdout sink
     * only when the module is built, so the document is checked against the module.
     */
    'documents the default sink of `destinations`', async () => {
      expect(TOP_LEVEL.get('destinations')).toBe(DESTINATIONS_CELL)
      const ref = await Test.createTestingModule({
        imports: [BymaxLoggerModule.forRoot(baseOptions)]
      }).compile()
      const destinations = ref.get<readonly ILogDestination[]>(LOGGER_DESTINATIONS_TOKEN, {
        strict: false
      })
      expect(destinations).toHaveLength(1)
      expect(destinations[0]).toBeInstanceOf(DefaultStdoutDestination)
      await ref.close()
    })

    it(/*
     * The `service.*` rows: required fields are the ones the caller must pass, the dash
     * rows are never filled in by the module, and `environment` falls back to NODE_ENV.
     */
    'documents the `service.*` fields', () => {
      const rows = [...TOP_LEVEL].filter(([name]) => name.startsWith('service.'))
      expect(rows.length).toBeGreaterThan(0)
      for (const [name, cell] of rows) {
        const field = name.replace(/^service\./, '')
        if (cell === '**Required**') {
          expect(Object.keys(service)).toContain(field)
        } else if (cell === '—') {
          expect(Object.keys(resolved.service)).not.toContain(field)
        } else {
          expect(name).toBe('service.environment')
          expect(cell).toBe('`NODE_ENV`')
          expect(resolveServiceMetadata(service, { NODE_ENV: 'staging' }).environment).toBe(
            'staging'
          )
          expect(resolveServiceMetadata(service, {}).environment).toBeUndefined()
        }
      }
    })
  })

  describe('completeness', () => {
    it(/*
     * Every option the module resolves has a row, and every row names a real option, so
     * an option added without documenting it, or removed without deleting its row,
     * fails. `service` has its own rows and `http` / `otel` their own tables.
     */
    'lists exactly the top-level options', () => {
      const documented = [...TOP_LEVEL.keys()].filter((name) => !name.startsWith('service.'))
      const real = Object.keys(resolved).filter((key) => !['service', 'http', 'otel'].includes(key))
      expect(documented.sort()).toEqual(real.sort())
    })

    it(/*
     * The `service.*` rows are exactly the fields of `ServiceMetadata`, which the
     * top-level completeness case above leaves out because `service` is not defaulted.
     */
    'lists exactly the service fields', () => {
      const documented = [...TOP_LEVEL.keys()]
        .filter((name) => name.startsWith('service.'))
        .map((name) => name.replace(/^service\./, ''))
      expect(documented.sort()).toEqual(Object.keys(everyServiceField).sort())
    })

    it(/*
     * A repeated option row must fail the parse instead of letting the last row stand in
     * for the first, which could carry the stale default.
     */
    'rejects a table that documents one option twice', () => {
      const table = [
        '### T',
        '',
        '| Option | Type | Default | Description |',
        '| --- | --- | --- | --- |',
        "| `level` | `string` | `'info'` | first |",
        "| `level` | `string` | `'debug'` | second |"
      ].join('\n')
      expect(() => parseOptionTable(table, '### T')).toThrow(/Duplicate row for "level"/)
    })

    it(/*
     * The http table lists exactly the keys of the resolved http options.
     */
    'lists exactly the http options', () => {
      const documented = [...HTTP.keys()].map((name) => name.replace(/^http\./, ''))
      expect(documented.sort()).toEqual(Object.keys(resolved.http).sort())
    })

    it(/*
     * The otel table lists exactly the keys of the resolved otel options.
     */
    'lists exactly the otel options', () => {
      const documented = [...OTEL.keys()].map((name) => name.replace(/^otel\./, ''))
      expect(documented.sort()).toEqual(Object.keys(resolved.otel).sort())
    })
  })
})
