/**
 * Verifies that an option left unset is read as unset: a key that holds `undefined` or `null` is
 * dropped before the options are merged with the defaults and validated, in the options themselves
 * and in every group, and a value is read from each known key by property access, so a getter on a
 * class instance counts. The options come from the resolved defaults, so an option added later is
 * covered without an edit.
 *
 * Layer: server/config, tests. A key written as `undefined` replaced its default in the spread of a
 * group, and a `null` was refused as a value of the wrong kind, though both say "not set".
 */
import { applyDefaults } from './default-options'
import { validateOptions } from './validate-options'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

const SERVICE = { name: 'app', version: '1.0.0' }
const BASE: BymaxLoggerModuleOptions = { service: SERVICE }

/** The resolved options with every function replaced by its kind, so two resolutions can be compared. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return '[function]'
  if (Array.isArray(value)) return value.map(shape)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
  }
  return value
}

const DEFAULTED = applyDefaults(BASE) as unknown as Record<string, unknown>

/** Every option of the resolved defaults except `service`, which has no default, and its groups' keys. */
const OPTION_PATHS: string[] = []
const GROUPS = ['http', 'otel', 'shutdown', 'destinationQueue']
for (const key of Object.keys(DEFAULTED)) {
  if (key === 'service') continue
  OPTION_PATHS.push(key)
  if (GROUPS.includes(key)) {
    for (const inner of Object.keys(DEFAULTED[key] as object)) OPTION_PATHS.push(`${key}.${inner}`)
  }
}

/** The options with `path` set to `value`, bypassing the compile-time types. */
function withValue(path: string, value: unknown): BymaxLoggerModuleOptions {
  const [head, tail] = path.split('.') as [string, string | undefined]
  const options: Record<string, unknown> = { service: SERVICE }
  options[head] = tail === undefined ? value : { [tail]: value }
  return options as unknown as BymaxLoggerModuleOptions
}

describe('an option that is not set', () => {
  it('covers every option and every key of every group', () => {
    expect(OPTION_PATHS.length).toBeGreaterThan(30)
    expect(OPTION_PATHS).toEqual(
      expect.arrayContaining(['level', 'maxStringLength', 'http.isEnabled', 'otel.fieldFormat'])
    )
  })

  describe.each(OPTION_PATHS)('options.%s', (path) => {
    it.each([
      ['undefined', undefined],
      ['null', null]
    ])(
      'is read as unset when it holds %s: it validates and the default is kept',
      (_label, value) => {
        const options = withValue(path, value)

        expect(() => validateOptions(options)).not.toThrow()
        expect(shape(applyDefaults(options))).toEqual(shape(applyDefaults(BASE)))
      }
    )
  })

  describe('a service that is not set', () => {
    it.each([
      ['undefined', undefined],
      ['null', null]
    ])('is required when it holds %s', (_label, value) => {
      const options = { service: value } as unknown as BymaxLoggerModuleOptions

      expect(() => validateOptions(options)).toThrow(/options\.service is required/)
    })
  })

  describe('a value read from a class instance', () => {
    /*
     * A getter on the prototype is not an own key, so a spread or an `Object.entries` of the
     * instance skips it and the default wins. Each known key is read by property access.
     */
    it('reads a getter of a group that is a class instance', () => {
      class HttpConfig {
        get isEnabled(): boolean {
          return true
        }

        get tenantIdHeader(): string {
          return 'x-org'
        }
      }
      const options = { ...BASE, http: new HttpConfig() } as unknown as BymaxLoggerModuleOptions

      const resolved = applyDefaults(options)

      expect(resolved.http.isEnabled).toBe(true)
      expect(resolved.http.tenantIdHeader).toBe('x-org')
      expect(resolved.http.shouldCaptureExceptions).toBe(true)
    })

    it('reads a getter of the options when they are a class instance', () => {
      class Options {
        readonly service = SERVICE

        get level(): string {
          return 'warn'
        }

        get isGlobal(): null {
          return null
        }
      }

      const resolved = applyDefaults(new Options() as unknown as BymaxLoggerModuleOptions)

      expect(resolved.level).toBe('warn')
      expect(resolved.isGlobal).toBe(true)
    })

    it('keeps the default for a key of a class instance whose getter returns undefined', () => {
      class OtelConfig {
        get traceIdField(): undefined {
          return undefined
        }

        get spanIdField(): string {
          return 'sid'
        }
      }
      const options = { ...BASE, otel: new OtelConfig() } as unknown as BymaxLoggerModuleOptions

      const resolved = applyDefaults(options)

      expect(resolved.otel.traceIdField).toBe('traceId')
      expect(resolved.otel.spanIdField).toBe('sid')
    })
  })
})
