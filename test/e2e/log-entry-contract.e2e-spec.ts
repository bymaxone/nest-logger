import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PINO_LEVEL_NUMBERS, PinoLoggerService } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'

import { parseLogEntries } from './fixtures/parse-log-entries'

/**
 * Contract test binding the PUBLISHED `LogEntry` declaration to a REAL
 * serialized record.
 *
 * The gap this closes: `LogEntry` declared `level: number` and
 * `time: string | number` while the runtime emitted the Pino string label and an
 * ISO 8601 string. Nothing compared the two, so a destination written against
 * the declaration compiled cleanly and then failed in production —
 * `check:published` compiles the README snippets but never runs them, and this
 * mismatch type-checks. Every assertion below therefore reads the value out of a
 * genuinely serialized line and puts it through the operation a destination
 * would perform on it.
 */
describe('Logger E2E — LogEntry contract', () => {
  let app: INestApplication | undefined
  let stdoutSpy: jest.SpyInstance
  let entry: LogEntry

  beforeEach(async () => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service: { name: 'e2e-contract', version: '1.2.3' } })]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    const logger = app.get(PinoLoggerService, { strict: false })
    logger.info('CONTRACT_PROBE', 'probe', 'u_1', { orderId: 'o_1' })
    // A single narrowing assertion, not a double-cast: `LogEntry` is assignable
    // to `Record<string, unknown>`, so this is the ordinary narrowing direction.
    // Whether it HOLDS at runtime is exactly what the assertions below verify.
    entry = parseLogEntries(stdoutSpy).find(
      (candidate) => candidate['logKey'] === 'CONTRACT_PROBE'
    ) as LogEntry
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it(/*
   * REGRESSION — audit finding C-2. `level` is the Pino string LABEL, never the
   * numeric code the declaration used to promise. Asserted through a variable
   * typed as the published `LogEntry`, so a future widening of the declaration
   * that drifts from the runtime fails to compile here.
   */
  'emits level as the Pino string label matching the declaration', () => {
    const level: LogEntry['level'] = entry.level
    expect(level).toBe('info')
    expect(typeof level).toBe('string')
  })

  it(/*
   * REGRESSION — audit finding C-2. `time` is an ISO 8601 string. The README's
   * Loki destination converted it with `BigInt(entry.time)`, which throws a
   * SyntaxError on an ISO string — the exact call is reproduced here to prove
   * the documented conversion path now works.
   */
  'emits time as an ISO 8601 string that converts to Loki nanoseconds', () => {
    const time: LogEntry['time'] = entry.time
    expect(typeof time).toBe('string')
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    // The old README call, verbatim — it threw on this value.
    expect(() => BigInt(time)).toThrow()
    // The corrected one, also verbatim from the README.
    const nanoseconds = String(BigInt(Date.parse(time)) * 1_000_000n)
    expect(nanoseconds).toMatch(/^\d+$/)
    // Compared as BigInt: nanoseconds since the epoch exceed Number.MAX_SAFE_INTEGER,
    // so round-tripping through `Number` would lose precision and make this flaky.
    expect(BigInt(nanoseconds) / 1_000_000n).toBe(BigInt(Date.parse(time)))
  })

  it(/*
   * The Prisma example stores a NUMERIC level column. With `level` being a
   * label, it has to map through `PINO_LEVEL_NUMBERS` — which is why that map is
   * now exported. Reproduces the documented conversion end to end.
   */
  'converts the level label to the numeric Pino code for a numeric column', () => {
    expect(PINO_LEVEL_NUMBERS[entry.level]).toBe(30)
    expect(new Date(entry.time).toISOString()).toBe(entry.time)
  })

  it(/*
   * The remaining declared fields must be present with their declared types on a
   * record produced by the library's own structured API.
   */
  'matches the declaration for the remaining structured fields', () => {
    expect(entry.msg).toBe('probe')
    expect(entry.logKey).toBe('CONTRACT_PROBE')
    expect(entry.userId).toBe('u_1')
    expect(entry.service).toEqual({ name: 'e2e-contract', version: '1.2.3' })
    expect(entry['orderId']).toBe('o_1')
  })
})
