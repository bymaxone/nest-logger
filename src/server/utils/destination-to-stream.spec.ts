import type { Writable } from 'node:stream'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { destinationToStream } from './destination-to-stream'

/** Write a single chunk and resolve/reject once the stream signals completion. */
function writeOnce(stream: Writable, chunk: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.write(chunk, (err) => (err ? reject(err) : resolve()))
  })
}

describe('destinationToStream', () => {
  let stderrSpy: jest.SpyInstance

  beforeEach(() => {
    // Write failures are reported to stderr (the safe sink) — capture + silence it.
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it(/*
   * A synchronous string write must reach the destination unchanged and complete
   * without error — the hot path for stdout-style destinations.
   */
  'forwards a synchronous string write to the destination', async () => {
    const destination: ILogDestination = { name: 'sync', write: jest.fn() }
    const stream = destinationToStream(destination)

    await writeOnce(stream, 'entry\n')

    expect(destination.write).toHaveBeenCalledWith('entry\n')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it(/*
   * Buffer chunks (the default when Pino writes binary) must be decoded as UTF-8
   * before reaching the destination — UTF-8 is the wire format Pino emits.
   */
  'decodes a Buffer chunk as UTF-8', async () => {
    const destination: ILogDestination = { name: 'buf', write: jest.fn() }
    const stream = destinationToStream(destination)

    await writeOnce(stream, Buffer.from('buffered\n', 'utf-8'))

    expect(destination.write).toHaveBeenCalledWith('buffered\n')
  })

  it(/*
   * An async destination (returns a Promise) must be awaited before the stream
   * callback fires, so back-pressure is respected.
   */
  'awaits an async destination write', async () => {
    const writeMock = jest.fn().mockResolvedValue(undefined)
    const stream = destinationToStream({ name: 'async', write: writeMock })

    await writeOnce(stream, 'async-entry\n')

    expect(writeMock).toHaveBeenCalledWith('async-entry\n')
  })

  it(/*
   * A rejected async write must be CONTAINED (fail-soft): the stream completes
   * WITHOUT error (never a crashing 'error' event) and the failure is reported
   * once to stderr as a structured LOGGER_DESTINATION_WRITE_FAILED line naming
   * the destination, the Error type, and the message.
   */
  'contains a rejected async write and reports it to stderr', async () => {
    const stream = destinationToStream({
      name: 'async-fail',
      write: jest.fn().mockRejectedValue(new Error('async-boom'))
    })

    await expect(writeOnce(stream, 'x\n')).resolves.toBeUndefined()

    const line = stderrSpy.mock.calls[0]?.[0] as string
    expect(line).toContain(RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED)
    expect(line).toContain('async-fail')
    expect(line).toContain('"type":"Error"')
    expect(line).toContain('async-boom')
  })

  it(/*
   * A non-Error async rejection must also be contained, with the value coerced
   * via String() and tagged UnknownError — covers the non-Error reportWriteFailure arm.
   */
  'contains a non-Error async rejection', async () => {
    const stream = destinationToStream({
      name: 'async-weird',
      write: jest.fn().mockRejectedValue('string-rejection')
    })

    await expect(writeOnce(stream, 'x\n')).resolves.toBeUndefined()

    const line = stderrSpy.mock.calls[0]?.[0] as string
    expect(line).toContain('"type":"UnknownError"')
    expect(line).toContain('string-rejection')
  })

  it(/*
   * A synchronous throw inside write must be caught and contained — reported to
   * stderr, never crashing the Pino producer.
   */
  'contains a synchronous throw and reports it to stderr', async () => {
    const stream = destinationToStream({
      name: 'sync-fail',
      write: jest.fn(() => {
        throw new Error('sync-boom')
      })
    })

    await expect(writeOnce(stream, 'x\n')).resolves.toBeUndefined()

    const line = stderrSpy.mock.calls[0]?.[0] as string
    expect(line).toContain('sync-fail')
    expect(line).toContain('sync-boom')
  })

  it(/*
   * A non-Error synchronous throw must also be contained and stringified.
   */
  'contains a non-Error synchronous throw', async () => {
    const stream = destinationToStream({
      name: 'sync-weird',
      write: jest.fn(() => {
        throw 'string-throw'
      })
    })

    await expect(writeOnce(stream, 'x\n')).resolves.toBeUndefined()

    expect(stderrSpy.mock.calls[0]?.[0]).toContain('string-throw')
  })

  it(/*
   * The safe sink itself can fail: if process.stderr.write throws (e.g. EPIPE on
   * a closed pipe), the failure report must be swallowed so the fail-soft
   * contract is absolute — a broken stderr must NOT turn a dropped log into a
   * host crash. The stream still completes without error. Covers the stderr
   * try/catch in reportWriteFailure.
   */
  'swallows a throwing stderr so a write failure still cannot crash the host', async () => {
    stderrSpy.mockImplementation(() => {
      throw new Error('EPIPE')
    })
    const stream = destinationToStream({
      name: 'sink-and-stderr-fail',
      write: jest.fn(() => {
        throw new Error('sink-boom')
      })
    })

    await expect(writeOnce(stream, 'x\n')).resolves.toBeUndefined()
    expect(stderrSpy).toHaveBeenCalled()
  })
})
