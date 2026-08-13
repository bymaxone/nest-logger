/**
 * Service metadata propagated to every log entry.
 *
 * Aligned with OpenTelemetry semantic conventions for service identity:
 *   {@link https://opentelemetry.io/docs/specs/semconv/resource/#service}
 */
export interface ServiceMetadata {
  /** OTel attribute `service.name` — stable identifier of the running service. */
  readonly name: string
  /** OTel attribute `service.version` — semver, commit SHA, or build tag. */
  readonly version: string
  /**
   * OTel attribute `service.namespace` (**Stable**) — the group the service
   * belongs to, e.g. a team, a bounded context or a tenant of the platform.
   * Two services may share a `name` as long as their namespaces differ.
   */
  readonly namespace?: string
  /**
   * OTel attribute `service.instance.id` (**Stable**) — identifies ONE running
   * instance, so the triplet (namespace, name, instanceId) is globally unique.
   *
   * The library never generates this. A value minted here would be the logger's
   * rather than the OpenTelemetry Resource's, so logs and traces would disagree
   * about which instance served a request, and it would change on every restart
   * while looking authoritative. Supply it from the platform — the Kubernetes
   * pod UID, the ECS task ARN, the VM instance id — or through
   * `OTEL_RESOURCE_ATTRIBUTES`, which is the same source the SDK reads.
   *
   * Treat it as HIGH cardinality: fine as a log field, not as a metric label.
   */
  readonly instanceId?: string
  /**
   * OTel attribute `deployment.environment.name` (**Stable**) — `production`,
   * `staging`, and so on. Falls back to `NODE_ENV` when omitted.
   *
   * The older `deployment.environment` spelling is **Deprecated** in the
   * semantic conventions and is never emitted.
   */
  readonly environment?: string
}

/**
 * Service identity after precedence has been applied.
 *
 * Distinct from {@link ServiceMetadata} because the optional fields here mean
 * "resolved to nothing" rather than "not configured": every source — options,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `NODE_ENV` — has already been
 * consulted, and a field still absent will not appear on any entry.
 */
export interface ResolvedServiceMetadata {
  /** `service.name`, always present. */
  name: string
  /** `service.version`, always present. */
  version: string
  /** `service.namespace`, when any source supplied one. */
  namespace?: string
  /** `service.instance.id`, when any source supplied one. */
  instanceId?: string
  /** `deployment.environment.name`, when any source supplied one. */
  environment?: string
}

/**
 * The `service` block as it appears in an EMITTED record, under the default
 * `resourceFormat: 'nested'`.
 *
 * Distinct from {@link ServiceMetadata} on purpose, and the distinction is the
 * kind of defect this library has already been bitten by once: a published type
 * that describes something the runtime never emits. `ServiceMetadata` is what a
 * consumer CONFIGURES — flat option names like `instanceId` and `environment`.
 * What comes out is the flattened OTel attribute path: `service.instance.id`
 * nests as `service: { instance: { id } }`, and the environment is not under
 * `service` at all, it is `deployment.environment.name`. Typing the emitted
 * record with the configuration interface would advertise `entry.service.instanceId`
 * to every consumer, and that property does not exist on any entry.
 *
 * Under `resourceFormat: 'flat'` these values appear as dotted top-level keys
 * (`"service.instance.id"`), which {@link LogEntry}'s index signature already
 * admits — a flat record simply has no `service` object.
 */
export interface EmittedServiceResource {
  /** OTel `service.name`. */
  readonly name: string
  /** OTel `service.version`. */
  readonly version: string
  /** OTel `service.namespace`, when resolved. */
  readonly namespace?: string
  /** OTel `service.instance.id`, nested as the attribute path spells it. */
  readonly instance?: { readonly id: string }
  /** Consumer-supplied extras carried through from the `service` option. */
  readonly [key: string]: unknown
}

/**
 * The `deployment` block as it appears in an EMITTED record under
 * `resourceFormat: 'nested'`, carrying `deployment.environment.name`.
 *
 * Absent entirely when no source resolved an environment. The deprecated
 * `deployment.environment` spelling is never emitted.
 */
export interface EmittedDeploymentResource {
  /** OTel `deployment.environment.name`, flattened from its attribute path. */
  readonly environment: { readonly name: string }
}
