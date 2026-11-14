/**
 * Pins which serializer a request under `req` reaches: the default one, or the host's own.
 *
 * Layer: server, tests, through a Pino instance and an in-memory destination.
 */
import { applyDefaults } from './config/default-options'
import { LogContextService } from './services/log-context.service'
import { buildPinoInstance, createCapture, baseOptions } from './__tests__/pino-factory.fixtures'

describe('buildPinoInstance, a request under req', () => {
  const request = {
    method: 'GET',
    url: '/probe?code=QUERY-SECRET',
    rawHeaders: ['Authorization', 'Bearer LEAK', 'Accept', 'text/html'],
    socket: { remoteAddress: '203.0.113.7' }
  }

  it('writes the four fields of a request, and not its query or its credential headers, by default', () => {
    const capture = createCapture()
    const logger = buildPinoInstance(applyDefaults(baseOptions), new LogContextService(), [
      capture.destination
    ])

    logger.info({ req: request }, 'seen')

    const [entry] = capture.entries()
    expect(entry?.['req']).toEqual({
      method: 'GET',
      url: '/probe',
      headers: {},
      remoteAddress: '203.0.113.7'
    })
    expect(JSON.stringify(entry)).not.toContain('QUERY-SECRET')
    expect(JSON.stringify(entry)).not.toContain('LEAK')
  })

  it('hands the request to a serializer of the host instead, which then decides what is written', () => {
    const capture = createCapture()
    const seen: unknown[] = []
    const logger = buildPinoInstance(
      applyDefaults({
        ...baseOptions,
        serializers: {
          req: (input: unknown): unknown => {
            seen.push(input)
            return { host: true }
          }
        }
      }),
      new LogContextService(),
      [capture.destination]
    )

    logger.info({ req: request }, 'seen')

    const [entry] = capture.entries()
    expect(entry?.['req']).toEqual({ host: true })
    expect(seen).toHaveLength(1)
    // The host's serializer gets the request as the redaction walk copied it, which still has the raw
    // headers a default serialization would have dropped.
    expect(Array.isArray((seen[0] as { rawHeaders?: unknown }).rawHeaders)).toBe(true)
  })
})
