import type { ServiceMetadata } from '../../shared/types/service-metadata.type'

import {
  buildResourceBindings,
  extraServiceFields,
  parseResourceAttributes,
  resolveServiceMetadata
} from './resolve-resource.util'

/** The minimum a consumer must supply. */
const BASE: ServiceMetadata = { name: 'checkout-api', version: '2.14.3' }

describe('parseResourceAttributes', () => {
  it('reads comma-separated key=value pairs', () => {
    expect(parseResourceAttributes('service.namespace=payments,service.version=9.9.9')).toEqual({
      'service.namespace': 'payments',
      'service.version': '9.9.9'
    })
  })

  it(/*
   * Values may be percent-encoded per the W3C Baggage format the variable
   * borrows, so a namespace containing a comma or space survives the round trip.
   */
  'percent-decodes values', () => {
    expect(parseResourceAttributes('service.namespace=team%20payments')).toEqual({
      'service.namespace': 'team payments'
    })
  })

  it(/*
   * This runs during module construction. A stray character in an environment
   * variable must never stop an application from booting — that would turn a
   * cosmetic misconfiguration into an outage — so malformed input is skipped and
   * the rest of the list is still read.
   */
  'rejects a pair whose key is empty', () => {
    // `=value` has its separator at index 0. Rejecting only "no `=` at all" would
    // let it through and define an attribute under the empty key.
    expect(parseResourceAttributes('=orphan,service.namespace=payments')).toStrictEqual({
      'service.namespace': 'payments'
    })
  })

  it(/*
   * This runs during module construction. A stray character in an environment
   * variable must never stop an application from booting.
   */
  'skips malformed pairs without throwing', () => {
    expect(() =>
      parseResourceAttributes('no-equals,=novalue,service.namespace=payments,trailing=')
    ).not.toThrow()
    expect(
      parseResourceAttributes('no-equals,=novalue,service.namespace=payments,trailing=')
    ).toStrictEqual({ 'service.namespace': 'payments' })
  })

  it(/*
   * A malformed percent-escape throws `URIError` in `decodeURIComponent`. The
   * raw text is kept rather than the attribute dropped: a literal `%` in a build
   * tag is far likelier than a deliberate escape, and the value is still useful.
   */
  'keeps the raw value when percent-decoding fails', () => {
    expect(parseResourceAttributes('service.version=1.0%zz')).toEqual({
      'service.version': '1.0%zz'
    })
  })

  it(/*
   * Operators write these lists with spaces after the commas. Without the trim
   * the key would carry a leading space and never match the attribute name it
   * was meant to set — silently, since a mismatched attribute simply does not
   * apply.
   */
  'trims whitespace around keys and values', () => {
    expect(
      parseResourceAttributes(' service.namespace = payments , service.version = 9.9.9 ')
    ).toEqual({
      'service.namespace': 'payments',
      'service.version': '9.9.9'
    })
  })

  it('yields nothing for an absent variable', () => {
    expect(parseResourceAttributes(undefined)).toEqual({})
  })

  it(/*
   * The parsed map is built with own data properties, so an attribute literally
   * named `__proto__` cannot reach the prototype chain of the result.
   */
  'cannot be prototype-polluted through an attribute name', () => {
    const parsed = parseResourceAttributes('__proto__=polluted,service.namespace=payments')

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('resolveServiceMetadata — precedence', () => {
  it(/*
   * Explicit configuration is the most specific statement an operator can make,
   * so it beats every environment source.
   */
  'prefers explicit options over the environment', () => {
    const resolved = resolveServiceMetadata(
      { ...BASE, namespace: 'explicit-ns', environment: 'explicit-env' },
      {
        OTEL_SERVICE_NAME: 'env-name',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=env-ns,service.version=9.9.9',
        NODE_ENV: 'production'
      }
    )

    expect(resolved).toEqual({
      name: 'checkout-api',
      version: '2.14.3',
      namespace: 'explicit-ns',
      environment: 'explicit-env'
    })
  })

  it(/*
   * The spec is explicit: "If `service.name` is also provided in
   * `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME` takes precedence."
   * This is a requirement, not a preference — getting it backwards makes the
   * logger disagree with the SDK reading the same two variables.
   */
  'lets OTEL_SERVICE_NAME beat service.name inside OTEL_RESOURCE_ATTRIBUTES', () => {
    const resolved = resolveServiceMetadata(
      { name: '', version: '' },
      {
        OTEL_SERVICE_NAME: 'from-service-name',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-attributes'
      }
    )

    expect(resolved.name).toBe('from-service-name')
  })

  it(/*
   * There is no `OTEL_SERVICE_VERSION` in the specification — the audit assumed
   * one existed. Version comes from the attribute list or from configuration,
   * and nowhere else.
   */
  'reads the version only from OTEL_RESOURCE_ATTRIBUTES', () => {
    const resolved = resolveServiceMetadata(
      { name: 'svc', version: '' },
      {
        OTEL_SERVICE_VERSION: 'ignored-because-not-a-spec-variable',
        OTEL_RESOURCE_ATTRIBUTES: 'service.version=3.1.4'
      }
    )

    expect(resolved.version).toBe('3.1.4')
  })

  it('falls back to NODE_ENV for the deployment environment', () => {
    const resolved = resolveServiceMetadata(BASE, { NODE_ENV: 'staging' })

    expect(resolved.environment).toBe('staging')
  })

  it(/*
   * The attribute list is closer to the SDK's own configuration than NODE_ENV,
   * which is a Node convention rather than an OTel one.
   */
  'prefers the OTel environment attribute over NODE_ENV', () => {
    const resolved = resolveServiceMetadata(BASE, {
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=production',
      NODE_ENV: 'development'
    })

    expect(resolved.environment).toBe('production')
  })

  it(/*
   * A variable set to the empty string is a misconfiguration, not a value.
   * Letting it win would replace a good explicit name with nothing.
   */
  'ignores empty environment values', () => {
    const resolved = resolveServiceMetadata(BASE, { OTEL_SERVICE_NAME: '', NODE_ENV: '' })

    expect(resolved.name).toBe('checkout-api')
    expect(resolved).not.toHaveProperty('environment')
  })

  it(/*
   * Absent means absent. Writing the key as `undefined` would put
   * `"namespace": null` on entries, which asserts "this service has no
   * namespace" where omission asserts nothing at all.
   */
  'omits optional fields no source supplied', () => {
    const resolved = resolveServiceMetadata(BASE, {})

    expect(Object.keys(resolved).sort()).toEqual(['name', 'version'])
  })

  it(/*
   * The library must NEVER mint a `service.instance.id`. The spec requires the
   * (namespace, name, instance) triplet to be globally unique; a UUID generated
   * here would be the logger's rather than the OTel Resource's, so logs and
   * traces would claim different instances of the same process — and it would
   * change on every restart while looking authoritative.
   */
  'never generates a service.instance.id', () => {
    const resolved = resolveServiceMetadata(BASE, {})

    expect(resolved).not.toHaveProperty('instanceId')
  })

  it('takes the instance id from the environment when the platform supplies one', () => {
    const resolved = resolveServiceMetadata(BASE, {
      OTEL_RESOURCE_ATTRIBUTES: 'service.instance.id=pod-7f3a'
    })

    expect(resolved.instanceId).toBe('pod-7f3a')
  })
})

describe('buildResourceBindings', () => {
  const full = {
    name: 'checkout-api',
    version: '2.14.3',
    namespace: 'payments',
    instanceId: 'pod-7f3a',
    environment: 'production'
  }

  it(/*
   * The default shape EXTENDS what 1.2.0 emitted rather than replacing it, so
   * every existing `service.name` / `service.version` query keeps working.
   * `service.instance.id` nests as `service.instance.id` — flattening the dotted
   * attribute name — because `service.instanceId` is a name no convention defines.
   */
  'nests the attributes under their dotted paths', () => {
    expect(buildResourceBindings(full, 'nested')).toStrictEqual({
      service: {
        name: 'checkout-api',
        version: '2.14.3',
        namespace: 'payments',
        instance: { id: 'pod-7f3a' }
      },
      deployment: { environment: { name: 'production' } }
    })
  })

  it(/*
   * The flat shape is what a collector mapping log fields onto resource
   * attributes reads directly, with no transformation step.
   */
  'emits verbatim dotted attribute names in flat mode', () => {
    expect(buildResourceBindings(full, 'flat')).toStrictEqual({
      'service.name': 'checkout-api',
      'service.version': '2.14.3',
      'service.namespace': 'payments',
      'service.instance.id': 'pod-7f3a',
      'deployment.environment.name': 'production'
    })
  })

  it.each([['nested' as const], ['flat' as const]])(
    /*
     * An unresolved optional attribute must not appear at all, in either shape.
     */
    'omits unresolved attributes in %s mode',
    (format) => {
      const bindings = buildResourceBindings({ name: 'svc', version: '1.0.0' }, format)

      // `in`, not `JSON.stringify`: a key written as `undefined` vanishes from
      // the JSON while still being present on the object, so a serialization
      // check cannot tell "omitted" from "written as undefined".
      expect('deployment' in bindings).toBe(false)
      expect('deployment.environment.name' in bindings).toBe(false)
      const service = (bindings['service'] ?? bindings) as Record<string, unknown>
      expect('namespace' in service).toBe(false)
      expect('service.namespace' in service).toBe(false)
      expect('instance' in service).toBe(false)
      expect('service.instance.id' in service).toBe(false)
    }
  )

  it(/*
   * REGRESSION — `base` used to receive the consumer's whole `service` object,
   * and consumers put build metadata on it. Emitting only the attributes this
   * module knows about would silently drop those keys.
   */
  'preserves consumer-supplied extras', () => {
    const bindings = buildResourceBindings(full, 'nested', { buildSha: 'abc123' })

    expect((bindings['service'] as Record<string, unknown>)['buildSha']).toBe('abc123')
  })

  it(/*
   * A resolved attribute always wins the key it owns, so a consumer who also put
   * `name` on the object gets the resolved value rather than a duplicate.
   */
  'lets resolved attributes win over an extra of the same name', () => {
    const bindings = buildResourceBindings(full, 'nested', { name: 'shadow' })

    expect((bindings['service'] as Record<string, unknown>)['name']).toBe('checkout-api')
  })

  it('prefixes extras in flat mode so everything stays dotted', () => {
    expect(buildResourceBindings(full, 'flat', { buildSha: 'abc123' })).toMatchObject({
      'service.buildSha': 'abc123'
    })
  })
})

describe('extraServiceFields', () => {
  it('returns only the keys the resolver does not own', () => {
    const extras = extraServiceFields({
      ...BASE,
      namespace: 'payments',
      instanceId: 'pod-1',
      environment: 'production',
      buildSha: 'abc123'
    } as ServiceMetadata)

    expect(extras).toEqual({ buildSha: 'abc123' })
  })

  it('returns nothing when the consumer supplied only known fields', () => {
    expect(extraServiceFields(BASE)).toEqual({})
  })
})

describe('resolveServiceMetadata — degenerate input', () => {
  it(/*
   * `name` and `version` are required by the option type, but a consumer using
   * `forRootAsync` can produce empty strings at runtime and no environment
   * source may fill them. The resolver must return empty strings rather than
   * `undefined`, because the emitted record's shape is fixed: a missing
   * `service.name` would change the entry's schema, not just its content.
   */
  'resolves to empty strings when no source supplies name or version', () => {
    const resolved = resolveServiceMetadata({ name: '', version: '' }, {})

    expect(resolved.name).toBe('')
    expect(resolved.version).toBe('')
  })
})

describe('resolveServiceMetadata — runtime values the types forbid', () => {
  it.each<[unknown, string]>([
    [null, 'null from a JSON config'],
    [undefined, 'undefined from an unset env var'],
    [42, 'a number'],
    [{}, 'an object']
  ])(
    /*
     * REGRESSION — the option type declares `name` and `version` as required
     * strings, but `forRootAsync` builds options at RUNTIME:
     * `version: process.env.APP_VERSION` is `undefined` when the variable is
     * unset, and a JSON config supplies `null`. Reading `.length` on either threw
     * during module construction, taking an application's boot down over a
     * missing environment variable. Found by falsification, not by a type.
     */
    'does not throw when version is %p (%s)',
    (version) => {
      expect(() =>
        resolveServiceMetadata({ name: 'svc', version } as unknown as ServiceMetadata, {})
      ).not.toThrow()
      expect(
        resolveServiceMetadata({ name: 'svc', version } as unknown as ServiceMetadata, {}).version
      ).toBe('')
    }
  )

  it('falls back to the environment when the configured name is not a string', () => {
    const resolved = resolveServiceMetadata(
      { name: null, version: '1.0.0' } as unknown as ServiceMetadata,
      { OTEL_SERVICE_NAME: 'from-env' }
    )

    expect(resolved.name).toBe('from-env')
  })
})
