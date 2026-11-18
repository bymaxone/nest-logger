/**
 * The readiness check of the logger, served by `@bymax-one/nest-core`.
 *
 * Layer: observability. A provider marked as a health indicator. The check reads the delivery
 * state the logger already keeps: it sends nothing to a destination, takes no time and cannot hang.
 */
import { BymaxHealthIndicator } from '@bymax-one/nest-core/health'
import type { HealthIndicatorResult, IHealthIndicator } from '@bymax-one/nest-core/health'
import { Inject, Injectable } from '@nestjs/common'

import { LOGGER_OBSERVABILITY_TOKEN } from '@bymax-one/nest-logger'
import type { ILoggerObservability } from '@bymax-one/nest-logger'

/** The name of the indicator in the readiness response. */
export const LOGGER_HEALTH_INDICATOR_NAME = 'logger'

/**
 * `up` when at least one log destination finished its `onInit` healthy, so an entry can still be
 * delivered; `down` when none did, which is also the state before the first has finished. The
 * details carry counts only: how many destinations finished their init, how many failed it and how
 * many have refused a write or had an entry dropped.
 */
@BymaxHealthIndicator()
@Injectable()
export class LoggerHealthIndicator implements IHealthIndicator {
  readonly name = LOGGER_HEALTH_INDICATOR_NAME

  /**
   * @param observability - The delivery state of the logger, provided by `BymaxLoggerModule`.
   */
  constructor(
    @Inject(LOGGER_OBSERVABILITY_TOKEN) private readonly observability: ILoggerObservability
  ) {}

  /**
   * Read the delivery state of the logger.
   *
   * @returns `up` or `down`, with the counts of the state as details.
   */
  check(): Promise<HealthIndicatorResult> {
    const { destinations, failedInit, writeFailing, hasHealthySink } =
      this.observability.deliveryState()
    return Promise.resolve({
      status: hasHealthySink ? 'up' : 'down',
      details: { destinations, failedInit, writeFailing }
    })
  }
}
