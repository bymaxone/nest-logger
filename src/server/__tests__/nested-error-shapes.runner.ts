/**
 * Runs one shape of a nested `Error` through the real Pino pipeline and judges the entry against
 * the one 1.4.8 wrote for the same shape.
 *
 * Layer: server, test support. Excluded from coverage and mutation with the rest of `__tests__`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyDefaults } from '../config/default-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { buildPinoInstance, resolveNameRedactor } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import { LogContextService } from '../services/log-context.service'
import { PinoLoggerService } from '../services/pino-logger.service'

/** What one shape logs: metadata, a root error, options, or bindings of a child logger. */
export interface Shape {
  meta?: Record<string, unknown>
  root?: unknown
  extra?: Partial<BymaxLoggerModuleOptions>
  child?: Record<string, unknown>
  /** Texts the entry must carry, for a shape on which the base failed and so cannot be compared. */
  keeps?: string[]
}

/** Keys that describe the process or the record, not the shape under test. */
const NOISE = [
  'level',
  'time',
  'pid',
  'hostname',
  'service',
  'deployment',
  'logKey',
  'userId',
  'event.name',
  'msg'
]

/** Markers of a secret that the shapes plant: a hit in the entry means it was written in clear. */
const LEAK = /LEAK|SECRET|TOSTR|SYMSECRET|PW|config-secret|STACK-secret|zzz/

/** What Pino writes in place of a key whose value its JSON stringify cannot handle. */
const UNSERIALIZABLE = /unable to serialize/

/** An HTTP-client error shape: its `toJSON` keeps the request, and the header text, out. */
export function axios(): Error {
  class AxiosLike extends Error {
    config = { url: '/x', headers: { Authorization: 'Bearer config-secret' } }
    request = { _header: 'GET / HTTP/1.1\r\nAuthorization: Bearer LEAKHDR' }
    constructor() {
      super('connect refused')
      this.name = 'AxiosLike'
    }
    toJSON(): Record<string, unknown> {
      return { message: this.message, name: this.name, code: 'E' }
    }
  }
  return new AxiosLike()
}

/**
 * Logs the shape and returns the parsed entry without the noise, with every stack masked.
 *
 * @param make - Builds the shape.
 * @returns The entry, or `THROW <message>` when the logging call threw.
 */
export function run(make: () => Shape): unknown {
  return runShape(make())
}

/** Logs an already built shape; see {@link run}. */
export function runShape(shape: Shape): unknown {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...shape.extra })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  const service = new PinoLoggerService(pino, resolveNameRedactor(options))
  const target = shape.child ? service.child(shape.child) : service
  try {
    target.errorStructured(
      'KEY',
      (shape.root ?? Object.assign(new Error('root'), { stack: 'Error: root' })) as Error,
      'u1',
      shape.meta ?? {}
    )
  } catch (error) {
    return 'THROW ' + (error as Error).message
  }
  const entry = JSON.parse(lines[0] ?? 'null', (key: string, value: unknown) =>
    key === 'stack' && typeof value === 'string' ? (value.split('\n')[0] ?? '') : value
  ) as Record<string, unknown> | null
  for (const key of NOISE) if (entry) Reflect.deleteProperty(entry, key)
  return entry
}

function leaves(value: unknown, into: Map<string, number>): Map<string, number> {
  if (Array.isArray(value)) value.forEach((item) => leaves(item, into))
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => leaves(item, into))
  } else if (value !== undefined) {
    const leaf = JSON.stringify(value)
    into.set(leaf, (into.get(leaf) ?? 0) + 1)
  }
  return into
}

function markers(value: unknown): Set<string> {
  const text = JSON.stringify(value).replace(/\[REDACTED\]/g, '')
  return new Set(text.match(new RegExp(LEAK, 'g')) ?? [])
}

const failedRecord = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && '_redactionFailed' in value

/**
 * What the new entry got worse at, compared with 1.4.8: it throws or fails the whole record where
 * the base did not, it shows a marker of a secret the base did not, or it dropped a leaf value
 * the base emitted (keys may change, values may not).
 *
 * @param base - The entry 1.4.8 wrote.
 * @param now - The entry written now.
 * @returns A description of the problem, or an empty string.
 */
export function problem(base: unknown, now: unknown): string {
  if (typeof now === 'string' && typeof base !== 'string') return 'throws: ' + now
  if (failedRecord(now) && !failedRecord(base)) return 'record-level failure'
  if (failedRecord(base) && !failedRecord(now)) return ''
  if (UNSERIALIZABLE.test(JSON.stringify(now)) && !UNSERIALIZABLE.test(JSON.stringify(base))) {
    return 'unserializable at stringify time'
  }
  const baseMarkers = markers(base)
  const added = [...markers(now)].filter((marker) => !baseMarkers.has(marker))
  if (added.length > 0) return 'LEAK ' + added.sort().join(',')
  // Counted, not collected: a value that 1.4.8 wrote twice and the new entry writes once is a loss.
  const kept = leaves(now, new Map())
  const lost = [...leaves(base, new Map())]
    .filter(([leaf, count]) => (kept.get(leaf) ?? 0) < count && !LEAK.test(leaf))
    .map(([leaf]) => leaf)
  return lost.length > 0 ? 'LOST ' + lost.sort().join(' ') : ''
}

/**
 * The entries 1.4.8 wrote for the shapes of one spec.
 *
 * @param file - Name of the recorded file under `__tests__`.
 * @returns The entries by shape name.
 */
export function loadBase(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, file), 'utf8')) as Record<string, unknown>
}

/**
 * Runs the shape and judges it against the entry 1.4.8 wrote: what the new entry got worse at, and
 * any text the shape says it must keep that is missing.
 *
 * @param base - The entry 1.4.8 wrote for the shape.
 * @param make - Builds the shape.
 * @returns A description of the problem, or an empty string.
 */
export function judge(base: unknown, make: () => Shape): string {
  const shape = make()
  const now = runShape(shape)
  const worse = problem(base, now)
  if (worse !== '') return worse
  const text = JSON.stringify(now)
  const missing = (shape.keeps ?? []).filter((kept) => !text.includes(kept))
  return missing.length > 0 ? 'MISSING ' + missing.join(' ') : ''
}
