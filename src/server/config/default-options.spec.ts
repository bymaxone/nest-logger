import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { applyDefaults } from './default-options'

const baseOptions: BymaxLoggerModuleOptions = {
  service: { name: 'app', version: '1.0.0' }
}

describe('applyDefaults', () => {
  const originalNodeEnv = process.env['NODE_ENV']

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV']
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  it(/*
   * Every optional field must receive a documented default so downstream
   * code never needs to handle `undefined`. Acts as a contract checker for
   * the shape returned by applyDefaults.
   */
  'should fill every optional field with the documented default', () => {
    process.env['NODE_ENV'] = 'development'
    const result = applyDefaults(baseOptions)
    expect(result.level).toBe('debug')
    expect(result.isGlobal).toBe(true)
    expect(result.shouldUseAsNestLogger).toBe(true)
    expect(result.redactPaths).toEqual([])
    expect(result.redactStrategy).toBe('names')
    expect(result.redactCensor).toBe('[REDACTED]')
    expect(result.shouldDisableDefaultRedact).toBe(false)
    expect(result.destinations).toEqual([])
    expect(result.isPretty).toBe(true)
    expect(result.maxEntrySizeBytes).toBe(65_536)
    expect(typeof result.timestamp).toBe('function')
    expect(typeof result.timestamp()).toBe('string')
  })

  it(/*
   * In production NODE_ENV the level default flips to `info` and pretty
   * mode flips off — protects against accidental verbose / pretty logs
   * being shipped to production.
   */
  'should default to info + pretty=false in production', () => {
    process.env['NODE_ENV'] = 'production'
    const result = applyDefaults(baseOptions)
    expect(result.level).toBe('info')
    expect(result.isPretty).toBe(false)
  })

  it(/*
   * Consumer-provided values must always win over defaults — guards against
   * a bug where the default short-circuits the user's choice.
   */
  'should respect explicit consumer overrides', () => {
    const result = applyDefaults({
      ...baseOptions,
      level: 'warn',
      isGlobal: false,
      shouldUseAsNestLogger: false,
      redactPaths: ['*.foo'],
      redactCensor: '[X]',
      shouldDisableDefaultRedact: true,
      isPretty: true,
      maxEntrySizeBytes: 1024
    })
    expect(result.level).toBe('warn')
    expect(result.isGlobal).toBe(false)
    expect(result.shouldUseAsNestLogger).toBe(false)
    expect(result.redactPaths).toEqual(['*.foo'])
    expect(result.redactCensor).toBe('[X]')
    expect(result.shouldDisableDefaultRedact).toBe(true)
    expect(result.isPretty).toBe(true)
    expect(result.maxEntrySizeBytes).toBe(1024)
  })

  it(/*
   * Sub-objects (http, otel) must be spread-merged so partial overrides
   * preserve sibling defaults. A naive replacement would drop unspecified
   * fields and break downstream consumers.
   */
  'should spread-merge http and otel sub-objects', () => {
    const result = applyDefaults({
      ...baseOptions,
      http: { isEnabled: true },
      otel: { shouldAutoInjectTraceContext: false }
    })
    expect(result.http.isEnabled).toBe(true)
    expect(result.http.shouldCaptureExceptions).toBe(true)
    expect(result.http.shouldGenerateRequestId).toBe(true)
    expect(result.http.tenantIdHeader).toBe('x-tenant-id')
    expect(result.otel.shouldAutoInjectTraceContext).toBe(false)
    expect(result.otel.traceIdField).toBe('traceId')
  })

  it(/*
   * The snake_case OTel shortcut must derive the wire-format field names
   * so consumers can opt into the OTel Logs Data Model with one flag.
   */
  'should apply snake_case OTel shortcut when fieldFormat is snake_case', () => {
    const result = applyDefaults({
      ...baseOptions,
      otel: { fieldFormat: 'snake_case' }
    })
    expect(result.otel.traceIdField).toBe('trace_id')
    expect(result.otel.spanIdField).toBe('span_id')
    expect(result.otel.traceFlagsField).toBe('trace_flags')
  })

  it(/*
   * Explicit `*Field` overrides must always win over the snake_case
   * shortcut — the shortcut only fills the gaps.
   */
  'should let explicit field overrides win over the snake_case shortcut', () => {
    const result = applyDefaults({
      ...baseOptions,
      otel: {
        fieldFormat: 'snake_case',
        traceIdField: 'customTrace',
        spanIdField: 'customSpan'
      }
    })
    expect(result.otel.traceIdField).toBe('customTrace')
    expect(result.otel.spanIdField).toBe('customSpan')
    expect(result.otel.traceFlagsField).toBe('trace_flags')
  })

  it(/*
   * Empty consumer maps must default to empty objects/arrays rather than
   * undefined so downstream consumers can iterate safely.
   */
  'should default serializers to an empty object', () => {
    const result = applyDefaults(baseOptions)
    expect(result.serializers).toEqual({})
  })

  it(/*
   * The OTel defaults (auto-inject ON, camelCase field names) must be pinned —
   * downstream trace correlation depends on these exact field names.
   */
  'should default otel auto-inject + camelCase field names', () => {
    const otel = applyDefaults(baseOptions).otel
    expect(otel.shouldAutoInjectTraceContext).toBe(true)
    expect(otel.spanIdField).toBe('spanId')
    expect(otel.traceFlagsField).toBe('traceFlags')
  })

  it(/*
   * The default excludePaths must be ANCHORED to exactly `/health` and
   * `/metrics` — not a substring/prefix match. Testing near-miss paths pins both
   * the `^` and `$` anchors so a regression that drops either is caught.
   */
  'should default excludePaths to anchored /health and /metrics', () => {
    const paths = applyDefaults(baseOptions).http.excludePaths
    expect(paths).toHaveLength(2)
    expect(paths[0]?.test('/health')).toBe(true)
    expect(paths[0]?.test('/healthy')).toBe(false) // pins the `$` anchor
    expect(paths[0]?.test('/api/health')).toBe(false) // pins the `^` anchor
    expect(paths[1]?.test('/metrics')).toBe(true)
    expect(paths[1]?.test('/metrics/v2')).toBe(false) // pins the `$` anchor
    expect(paths[1]?.test('/v1/metrics')).toBe(false) // pins the `^` anchor
  })

  it(/*
   * The returned snapshot must be frozen at the top level AND across its nested
   * `service` / `serializers` bags, so accidental mutation by consumer code (or
   * a per-request handler) is loud rather than silently corrupting the shared
   * global options snapshot.
   */
  'should return a snapshot frozen at the top level, service, and serializers', () => {
    const result = applyDefaults({ ...baseOptions, serializers: { foo: (x: unknown) => x } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.service)).toBe(true)
    expect(Object.isFrozen(result.serializers)).toBe(true)
  })
})
