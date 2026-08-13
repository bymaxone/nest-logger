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
