import {
  LOG_LEVEL_PRIORITY,
  NEST_TO_PINO_LEVEL,
  PINO_LEVEL_NAMES,
  PINO_LEVEL_NUMBERS
} from './log-levels.constants'

describe('PINO_LEVEL_NUMBERS', () => {
  it.each([
    ['fatal', 60],
    ['error', 50],
    ['warn', 40],
    ['info', 30],
    ['debug', 20],
    ['trace', 10]
  ])(
    /*
     * Pino's numeric level contract is part of the wire format consumed by
     * external dashboards (Datadog, Loki). Drift would silently change alert
     * thresholds — pin every entry.
     */
    'should map %s to %i',
    (level, expected) => {
      expect(PINO_LEVEL_NUMBERS[level as keyof typeof PINO_LEVEL_NUMBERS]).toBe(expected)
    }
  )
})

describe('PINO_LEVEL_NAMES', () => {
  it.each([
    [60, 'fatal'],
    [50, 'error'],
    [40, 'warn'],
    [30, 'info'],
    [20, 'debug'],
    [10, 'trace']
  ])(
    /*
     * Reverse lookup must mirror PINO_LEVEL_NUMBERS exactly so that destinations
     * decoding numeric levels back to strings stay consistent.
     */
    'should map %i back to %s',
    (num, expected) => {
      expect(PINO_LEVEL_NAMES[num]).toBe(expected)
    }
  )
})

describe('NEST_TO_PINO_LEVEL', () => {
  it.each([
    ['log', 'info'],
    ['error', 'error'],
    ['warn', 'warn'],
    ['debug', 'debug'],
    ['verbose', 'trace'],
    ['fatal', 'fatal']
  ])(
    /*
     * The bridge keeps NestJS's vocabulary mapped to Pino — `log → info` and
     * `verbose → trace` are the two non-identity entries that matter for
     * application logs that flow through `LoggerService.log()`.
     */
    'should bridge NestJS %s to Pino %s',
    (nestLevel, expected) => {
      expect(NEST_TO_PINO_LEVEL[nestLevel]).toBe(expected)
    }
  )
})

describe('LOG_LEVEL_PRIORITY', () => {
  it(/*
   * Priority order is consumed by destination filtering — the index of a
   * level decides whether it passes the destination's `minLevel`. Drift
   * here would cause errors to be silently dropped.
   */
  'should list levels in ascending severity order', () => {
    expect(LOG_LEVEL_PRIORITY).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  })

  it(/*
   * Index-based filtering needs every Pino level to be present — guard
   * against a level being accidentally removed from the ordering array.
   */
  'should contain every Pino level exactly once', () => {
    expect(new Set(LOG_LEVEL_PRIORITY).size).toBe(LOG_LEVEL_PRIORITY.length)
    for (const level of Object.keys(PINO_LEVEL_NUMBERS)) {
      expect(LOG_LEVEL_PRIORITY).toContain(level)
    }
  })
})
