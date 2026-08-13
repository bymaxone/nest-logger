/**
 * Resource identity resolution — the contract logs, traces and metrics share.
 *
 * Layer: server/utils — turns the consumer's `service` options plus the
 * OpenTelemetry environment into one resolved identity, emitted on every entry.
 *
 * Why this exists at all. A log saying `service.version = 1.7.0` while the
 * active OTel Resource says `1.8.0` is worse than a log with no version: it
 * makes two signals about the same request disagree, and nothing downstream can
 * tell which is lying. The fix is not to guess harder, it is to read the SAME
 * source the SDK reads. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are
 * that source — the SDK's own configuration surface — so a service configured
 * once through the environment gets one identity in both signals without the
 * logger depending on the SDK.
 *
 * Precedence, deterministic and in this order:
 *   1. explicit `service` options passed to `forRoot`/`forRootAsync`
 *   2. `OTEL_SERVICE_NAME` (name only)
 *   3. `OTEL_RESOURCE_ATTRIBUTES`
 *   4. `NODE_ENV` (environment only)
 *
 * Explicit configuration wins because it is the most specific statement the
 * operator can make. Between the two OTel variables the order is not a
 * preference — the specification requires it: "If `service.name` is also
 * provided in `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME` takes
 * precedence."
 *
 * Attribute stability, verified against Semantic Conventions **v1.44.0** on
 * 2026-08-13: `service.name`, `service.namespace`, `service.version`,
 * `service.instance.id` and `deployment.environment.name` are all **Stable**.
 * `deployment.environment` is **Deprecated** and is never emitted here.
 * `deployment.id` / `.name` / `.status` are **Development** and are out of scope.
 */
import type {
  ResolvedServiceMetadata,
  ServiceMetadata
} from '../../shared/types/service-metadata.type'

/** OTel attribute key for the service namespace. */
const ATTR_NAMESPACE = 'service.namespace'
/** OTel attribute key for the service version. */
const ATTR_VERSION = 'service.version'
/** OTel attribute key for the service name. */
const ATTR_NAME = 'service.name'
/** OTel attribute key for the service instance identity. */
const ATTR_INSTANCE_ID = 'service.instance.id'
/** OTel attribute key for the deployment environment (the Stable spelling). */
const ATTR_ENVIRONMENT = 'deployment.environment.name'

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` into a map.
 *
 * The value is a comma-separated list of `key=value` pairs whose values may be
 * percent-encoded. Malformed input is SKIPPED rather than thrown on: this runs
 * during module construction, and a stray character in an environment variable
 * must not stop an application from booting — it would turn a cosmetic
 * misconfiguration into an outage. A pair with no `=`, an empty key, or a value
 * that fails to decode is dropped and the rest is still read.
 *
 * @param raw - The raw environment value, or `undefined`.
 * @returns Attribute key/value pairs; empty when there is nothing usable.
 * @example
 *   parseResourceAttributes('service.namespace=payments,service.version=2.14.3')
 *   // → { 'service.namespace': 'payments', 'service.version': '2.14.3' }
 */
export function parseResourceAttributes(raw: string | undefined): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {}
  if (raw === undefined) {
    return parsed
  }
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=')
    // `<= 0` covers both rejections in one test: `-1` is "no `=` at all", and `0`
    // is a pair like `=value` whose key is empty. Splitting them into two checks
    // made the second unreachable — the first already rejected everything it
    // would have caught — which is a branch no input can distinguish.
    if (separator <= 0) {
      continue
    }
    const key = pair.slice(0, separator).trim()
    const rawValue = pair.slice(separator + 1).trim()
    if (rawValue.length === 0) {
      continue
    }
    let value: string
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      // A malformed percent-escape (`%zz`) throws URIError. Keep the raw text
      // rather than dropping the attribute: a literal `%` in a version string is
      // far more likely than a deliberate escape, and the value is still useful.
      value = rawValue
    }
    // `defineProperty` rather than assignment: it is what keeps an attribute
    // literally named `__proto__` from reaching the prototype chain.
    //
    // `configurable: true` is load-bearing, and its absence was a real defect: a
    // REPEATED key (`service.name=a,service.name=b`) calls this twice, and
    // redefining a non-configurable property throws `TypeError`. That exception
    // escaped `resolveServiceMetadata` and aborted module construction —
    // precisely the "a stray character must never stop an application from
    // booting" contract this parser exists to keep. Last occurrence wins, which
    // matches how an operator reading left-to-right would expect an override to
    // behave.
    Object.defineProperty(parsed, key, { value, enumerable: true, configurable: true })
  }
  return parsed
}

/**
 * Read one attribute out of a parsed map without tripping prototype lookups.
 *
 * @param attributes - The parsed attribute map.
 * @param key - The attribute name.
 * @returns The value, or `undefined` when absent or empty.
 */
function attribute(attributes: Readonly<Record<string, string>>, key: string): string | undefined {
  const value: unknown = Object.hasOwn(attributes, key) ? Reflect.get(attributes, key) : undefined
  // No emptiness check: `parseResourceAttributes` already drops empty values, so
  // a second guard here would be a branch no input can reach.
  return typeof value === 'string' ? value : undefined
}

/**
 * The first usable candidate, ignoring anything that is not a non-empty string.
 *
 * Typed as `unknown` rather than `string | undefined` on purpose. The option type
 * declares `name` and `version` as required strings, but `forRootAsync` builds
 * options at RUNTIME — `version: process.env.APP_VERSION` yields `undefined` when
 * the variable is unset, and a JSON config yields `null`. A `.length` read on
 * either throws, and this runs during module construction, so it would take an
 * application's boot down over a missing environment variable. Found by feeding
 * the resolver values its types say cannot occur.
 *
 * @param candidates - Values in precedence order.
 * @returns The first non-empty string, or `undefined`.
 */
function firstNonEmpty(...candidates: unknown[]): string | undefined {
  const found = candidates.find(
    (candidate) => typeof candidate === 'string' && candidate.length > 0
  )
  return found as string | undefined
}

/**
 * Resolve the service identity emitted on every log entry.
 *
 * `instanceId` is **never generated**. The specification requires the triplet
 * (`service.namespace`, `service.name`, `service.instance.id`) to be globally
 * unique, and recommends a random UUID — but a UUID minted here would be the
 * LOGGER's, not the SDK's, so logs and traces would claim different instances of
 * the same process. Worse, it would change on every restart while looking
 * authoritative. Infrastructure and the OTel Resource are the right sources, so
 * the value is taken from configuration or the environment, or omitted. Omission
 * is honest; a plausible wrong answer is not.
 *
 * @param service - The consumer-supplied service metadata.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The resolved identity, with absent fields omitted.
 * @example
 *   resolveServiceMetadata({ name: 'checkout-api', version: '2.14.3' },
 *     { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=payments', NODE_ENV: 'production' })
 *   // → { name: 'checkout-api', version: '2.14.3',
 *   //     namespace: 'payments', environment: 'production' }
 */
export function resolveServiceMetadata(
  service: ServiceMetadata,
  env: NodeJS.ProcessEnv = process.env
): ResolvedServiceMetadata {
  const attributes = parseResourceAttributes(env['OTEL_RESOURCE_ATTRIBUTES'])

  const resolved: ResolvedServiceMetadata = {
    // The spec's precedence: OTEL_SERVICE_NAME beats service.name in the
    // attribute list. Explicit configuration still beats both.
    name:
      firstNonEmpty(service.name, env['OTEL_SERVICE_NAME'], attribute(attributes, ATTR_NAME)) ?? '',
    version: firstNonEmpty(service.version, attribute(attributes, ATTR_VERSION)) ?? ''
  }

  // Optional fields are ASSIGNED ONLY WHEN PRESENT rather than written as
  // `undefined`: an own key holding `undefined` still serializes into the base
  // bindings on some paths, and an entry carrying `"service.namespace": null`
  // asserts "this service has no namespace" where absence asserts nothing.
  const namespace = firstNonEmpty(service.namespace, attribute(attributes, ATTR_NAMESPACE))
  if (namespace !== undefined) {
    resolved.namespace = namespace
  }
  const instanceId = firstNonEmpty(service.instanceId, attribute(attributes, ATTR_INSTANCE_ID))
  if (instanceId !== undefined) {
    resolved.instanceId = instanceId
  }
  const environment = firstNonEmpty(
    service.environment,
    attribute(attributes, ATTR_ENVIRONMENT),
    env['NODE_ENV']
  )
  if (environment !== undefined) {
    resolved.environment = environment
  }
  return resolved
}

/**
 * Shape the resolved identity into the object Pino puts in `base`.
 *
 * `'nested'` (the default) keeps today's `{ service: { name, version } }` shape
 * and extends it, so no existing query breaks. `'flat'` emits the dotted OTel
 * attribute names verbatim, which is what a collector mapping log fields to
 * resource attributes wants to see.
 *
 * @param resolved - The resolved service identity.
 * @param format - `'nested'` for the legacy shape, `'flat'` for dotted keys.
 * @param extras - Any additional keys the consumer put on `service`. They are
 *   preserved rather than dropped: `applyDefaults` has always passed the whole
 *   object through, consumers use it for build metadata, and silently discarding
 *   it would be a regression. They still pass through redaction like any other
 *   base binding.
 * @returns The base bindings object.
 * @example
 *   buildResourceBindings({ name: 'api', version: '1.0.0', instanceId: 'pod-1' }, 'nested')
 *   // → { service: { name: 'api', version: '1.0.0', instance: { id: 'pod-1' } } }
 * @example
 *   buildResourceBindings({ name: 'api', version: '1.0.0' }, 'flat')
 *   // → { 'service.name': 'api', 'service.version': '1.0.0' }
 */
export function buildResourceBindings(
  resolved: ResolvedServiceMetadata,
  format: 'nested' | 'flat',
  extras: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  if (format === 'flat') {
    const flat: Record<string, unknown> = {
      [ATTR_NAME]: resolved.name,
      [ATTR_VERSION]: resolved.version
    }
    // Consumer-supplied extras keep a `service.` prefix so everything on the
    // entry stays addressable by one dotted convention.
    for (const [key, value] of Object.entries(extras)) {
      Reflect.set(flat, `service.${key}`, value)
    }
    if (resolved.namespace !== undefined) {
      Reflect.set(flat, ATTR_NAMESPACE, resolved.namespace)
    }
    if (resolved.instanceId !== undefined) {
      Reflect.set(flat, ATTR_INSTANCE_ID, resolved.instanceId)
    }
    if (resolved.environment !== undefined) {
      Reflect.set(flat, ATTR_ENVIRONMENT, resolved.environment)
    }
    return flat
  }

  // Extras FIRST so a resolved attribute always wins the key it owns: a consumer
  // who also passed `name` gets the resolved one, not a duplicate.
  const service: Record<string, unknown> = {
    ...extras,
    name: resolved.name,
    version: resolved.version
  }
  if (resolved.namespace !== undefined) {
    service['namespace'] = resolved.namespace
  }
  if (resolved.instanceId !== undefined) {
    // `service.instance.id` nests as `service: { instance: { id } }`, which is
    // what flattening the dotted attribute name produces. Emitting
    // `service.instanceId` instead would be a name no convention defines.
    service['instance'] = { id: resolved.instanceId }
  }
  const bindings: Record<string, unknown> = { service }
  if (resolved.environment !== undefined) {
    bindings['deployment'] = { environment: { name: resolved.environment } }
  }
  return bindings
}

/** Keys the resolver owns; anything else on `service` is consumer metadata. */
const OWNED_SERVICE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'namespace',
  'instanceId',
  'environment'
])

/**
 * The consumer's own additions to `service`, minus the fields this module owns.
 *
 * `applyDefaults` keeps whatever object it was handed, and consumers put build
 * metadata there. Those keys must survive the move to a resolved identity —
 * dropping them would be a silent regression for anyone querying them.
 *
 * @param service - The consumer-supplied service metadata.
 * @returns The extra keys, or an empty object when there are none.
 * @example
 *   extraServiceFields({ name: 'api', version: '1.0.0', buildSha: 'abc123' })
 *   // → { buildSha: 'abc123' }
 */
export function extraServiceFields(service: ServiceMetadata): Readonly<Record<string, unknown>> {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries<unknown>({ ...service })) {
    if (!OWNED_SERVICE_KEYS.has(key)) {
      // `Reflect` keeps the dynamic write off the object-injection sink list.
      Reflect.set(extras, key, value)
    }
  }
  return extras
}
