/**
 * Shared fixtures of the `pino-factory` specs: a `buildPinoInstance` with an all-healthy
 * `DestinationHealth`, an in-memory capture destination and the minimal module options.
 *
 * Layer: server, tests.
 */
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { buildPinoInstance as buildPinoInstanceWithHealth } from '../pino-factory'
import { DestinationHealth } from '../services/destination-health.service'
import type { LogContextService } from '../services/log-context.service'

/**
 * `buildPinoInstance` with a fresh, all-healthy `DestinationHealth`.
 *
 * Every case below exercises the fan-out with destinations that initialized, so
 * the health record is uniform noise at these call sites. The health-aware
 * behaviour (a failed sink skipped, a total failure rescued to stdout) belongs to
 * the wrapper and is asserted in `destination-to-stream.spec.ts` against the
 * record directly, rather than through a Pino instance that cannot observe it.
 */
export function buildPinoInstance(
  options: ResolvedBymaxLoggerModuleOptions,
  logContext: LogContextService,
  destinations: readonly ILogDestination[],
  health: DestinationHealth = new DestinationHealth()
): ReturnType<typeof buildPinoInstanceWithHealth> {
  return buildPinoInstanceWithHealth(options, logContext, destinations, health)
}

/** In-memory destination capturing each emitted NDJSON line as a parsed entry. */
export function createCapture(name = 'capture'): {
  destination: ILogDestination
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  return {
    destination: {
      name,
      write(line: string): void {
        lines.push(line)
      }
    },
    entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    }
  }
}

/** The minimal module options the `pino-factory` specs extend: only the service identity. */
export const baseOptions = { service: { name: 'app', version: '1.0.0' } }
