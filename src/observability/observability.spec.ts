/**
 * Pins the observability subpath: the two Prometheus counters read the logger's counts at scrape
 * time, as the growth since the last scrape, with a closed set of labels and a series for each
 * reason from the first scrape; the readiness check is `up` with a healthy destination and `down`
 * without, with counts only in its details; both providers carry the markers `nest-core` discovers.
 *
 * Layer: server, tests. Reads a real `prom-client` registry.
 */
import 'reflect-metadata'
import { BYMAX_HEALTH_INDICATOR_METADATA } from '@bymax-one/nest-core/health'
import { BYMAX_METRICS_CONTRIBUTOR_METADATA } from '@bymax-one/nest-core/metrics'
import type { DeliveryState, ILoggerObservability, TruncationReason } from '@bymax-one/nest-logger'
import { Registry } from 'prom-client'

import {
  BymaxLoggerObservabilityModule,
  LOGGER_HEALTH_INDICATOR_NAME,
  LoggerHealthIndicator,
  LoggerMetricsContributor
} from './index'

/** A logger view whose counts the test moves. */
class FakeObservability implements ILoggerObservability {
  entrySize = 0
  stringLength = 0
  errors = 0
  state: DeliveryState = {
    destinations: 1,
    failedInit: 0,
    writeFailing: 0,
    hasHealthySink: true
  }

  truncatedTotal(reason: TruncationReason): number {
    return reason === 'max_entry_size' ? this.entrySize : this.stringLength
  }

  destinationErrorTotal(): number {
    return this.errors
  }

  deliveryState(): DeliveryState {
    return this.state
  }
}

async function scrape(registry: Registry): Promise<string> {
  return registry.metrics()
}

const TRUNCATED = 'bymax_logger_entries_truncated_total'
const ERRORS = 'bymax_logger_destination_errors_total'

function sample(text: string, line: string): number | undefined {
  const match = text.split('\n').find((row) => row.startsWith(`${line} `))
  return match === undefined ? undefined : Number(match.slice(line.length + 1))
}

describe('LoggerMetricsContributor', () => {
  const create = (): { observability: FakeObservability; registry: Registry } => {
    const observability = new FakeObservability()
    const registry = new Registry()
    new LoggerMetricsContributor(observability).registerMetrics(registry)
    return { observability, registry }
  }

  it('publishes both counters with their help text, as counters', async () => {
    const { registry } = create()

    const text = await scrape(registry)

    expect(text).toContain(`# HELP ${TRUNCATED} Fields of a log entry cut or replaced`)
    expect(text).toContain(`# TYPE ${TRUNCATED} counter`)
    expect(text).toContain(`# HELP ${ERRORS} Writes to a log destination that threw or rejected.`)
    expect(text).toContain(`# TYPE ${ERRORS} counter`)
  })

  it('has a series for each reason at zero from the first scrape', async () => {
    const { registry } = create()

    const text = await scrape(registry)

    expect(sample(text, `${TRUNCATED}{reason="max_entry_size"}`)).toBe(0)
    expect(sample(text, `${TRUNCATED}{reason="max_string_length"}`)).toBe(0)
    expect(sample(text, ERRORS)).toBe(0)
  })

  it('shows the counts of the logger, and only the growth since the last scrape is added', async () => {
    const { observability, registry } = create()
    observability.entrySize = 3
    observability.stringLength = 5
    observability.errors = 2

    const first = await scrape(registry)
    const second = await scrape(registry)
    observability.entrySize = 4
    observability.errors = 7
    const third = await scrape(registry)

    expect(sample(first, `${TRUNCATED}{reason="max_entry_size"}`)).toBe(3)
    expect(sample(first, `${TRUNCATED}{reason="max_string_length"}`)).toBe(5)
    expect(sample(first, ERRORS)).toBe(2)
    expect(sample(second, `${TRUNCATED}{reason="max_entry_size"}`)).toBe(3)
    expect(sample(second, ERRORS)).toBe(2)
    expect(sample(third, `${TRUNCATED}{reason="max_entry_size"}`)).toBe(4)
    expect(sample(third, `${TRUNCATED}{reason="max_string_length"}`)).toBe(5)
    expect(sample(third, ERRORS)).toBe(7)
  })

  it('keeps the label values to the closed set, whatever the counts', async () => {
    const { observability, registry } = create()
    observability.entrySize = 10
    observability.stringLength = 10

    const text = await scrape(registry)

    const reasons = [...text.matchAll(/reason="([^"]*)"/g)].map((match) => match[1])
    expect([...new Set(reasons)].sort()).toEqual(['max_entry_size', 'max_string_length'])
    expect(text).not.toMatch(new RegExp(`${ERRORS}\\{`))
  })

  it('refuses to register the same names twice on one registry', () => {
    const { registry } = create()

    expect(() =>
      new LoggerMetricsContributor(new FakeObservability()).registerMetrics(registry)
    ).toThrow(/already been registered/)
  })
})

describe('LoggerHealthIndicator', () => {
  const check = async (state: DeliveryState) => {
    const observability = new FakeObservability()
    observability.state = state
    return new LoggerHealthIndicator(observability).check()
  }

  it('is named logger', () => {
    expect(new LoggerHealthIndicator(new FakeObservability()).name).toBe(
      LOGGER_HEALTH_INDICATOR_NAME
    )
    expect(LOGGER_HEALTH_INDICATOR_NAME).toBe('logger')
  })

  it('is up when a destination is healthy, with counts only in its details', async () => {
    const result = await check({
      destinations: 2,
      failedInit: 1,
      writeFailing: 1,
      hasHealthySink: true
    })

    expect(result).toEqual({
      status: 'up',
      details: { destinations: 2, failedInit: 1, writeFailing: 1 }
    })
  })

  it('is down when no destination is healthy, which includes before the first has finished', async () => {
    const result = await check({
      destinations: 0,
      failedInit: 0,
      writeFailing: 0,
      hasHealthySink: false
    })

    expect(result.status).toBe('down')
  })
})

describe('the markers and the module', () => {
  it('marks the contributor and the indicator for discovery', () => {
    expect(Reflect.getMetadata(BYMAX_METRICS_CONTRIBUTOR_METADATA, LoggerMetricsContributor)).toBe(
      true
    )
    expect(Reflect.getMetadata(BYMAX_HEALTH_INDICATOR_METADATA, LoggerHealthIndicator)).toBe(true)
  })

  it('provides and exports both', () => {
    const providers = Reflect.getMetadata('providers', BymaxLoggerObservabilityModule) as unknown[]
    const exported = Reflect.getMetadata('exports', BymaxLoggerObservabilityModule) as unknown[]

    expect(providers).toEqual([LoggerMetricsContributor, LoggerHealthIndicator])
    expect(exported).toEqual([LoggerMetricsContributor, LoggerHealthIndicator])
  })
})
