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
}
