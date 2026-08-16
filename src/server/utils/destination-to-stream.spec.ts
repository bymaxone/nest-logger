import type { Writable } from 'node:stream'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { DestinationHealth } from '../services/destination-health.service'

import { destinationToStream as destinationToStreamWithHealth } from './destination-to-stream'

/**
 * `destinationToStream` with an empty health record — nothing marked failed, so
 * every destination is treated as live. The health-aware branches pass their own
 * record explicitly.
 */
function destinationToStream(
  destination: ILogDestination,
  health: DestinationHealth = new DestinationHealth()
): Writable {
  return destinationToStreamWithHealth(destination, health)
}

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
    expect(line).toContain('"level":"error"')
    expect(line).toContain('failed to write')
    expect(line.endsWith('\n')).toBe(true)
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

  describe('a write that returns a thenable rather than a Promise', () => {
    it(/*
     * REGRESSION — `instanceof Promise` is realm-local and answers `false` for a
     * promise built in another realm (worker, vm context) and for any
     * structurally valid thenable. Both were measured. Such a write took the
     * SYNCHRONOUS path: the callback fired immediately, a later rejection escaped
     * as an unhandled rejection instead of being reported, and the write was
     * never counted as pending — so readiness could tell a buffering sink to
     * discard its only copy of an entry that was about to fail. Losing an entry
     * is the one outcome this library does not accept.
     *
     * This repo already learned the realm-local lesson from `instanceof Error`,
     * which is why `isErrorLike` exists; the same mistake sat one file away.
     */
    'contains a rejection from a non-Promise thenable', async () => {
      const destination: ILogDestination = {
        name: 'thenable',
        // A valid thenable that is NOT `instanceof Promise` — what a worker
        // boundary or a hand-rolled deferred returns. No cast: the contract is
        // `void | PromiseLike<void>`, so this is exactly what it permits.
        write: (): PromiseLike<void> => ({
          // `then` is typed the way `PromiseLike` declares it, so no cast is
          // needed anywhere: the contract is `void | PromiseLike<void>`, and this
          // is precisely what that permits. The returned promise never settles —
          // `Promise.resolve` ignores it, and nothing here awaits it.
          then: <TResult1 = void, TResult2 = never>(
            _onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
          ): PromiseLike<TResult1 | TResult2> => {
            setTimeout(() => onrejected?.(new Error('async write failed')), 1)
            return new Promise<TResult1 | TResult2>(() => undefined)
          }
        })
      }
      const health = new DestinationHealth()
      health.markHealthy(destination, 'info')
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
      const stream = destinationToStream(destination, health)

      await expect(writeOnce(stream, 'entry\n')).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Reported rather than escaping as an unhandled rejection.
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('async write failed'))
      stderrSpy.mockRestore()
    })

    it(/*
     * And it must be counted as in flight while it is, so readiness cannot claim
     * delivery from a sink whose write has not settled — the reason the pending
     * counter exists at all.
     */
    'counts a thenable write as pending until it settles', async () => {
      let settle: (() => void) | undefined
      const destination: ILogDestination = {
        name: 'thenable',
        write: (): PromiseLike<void> => ({
          then: <TResult1 = void, TResult2 = never>(
            onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null
          ): PromiseLike<TResult1 | TResult2> => {
            settle = (): void => void onfulfilled?.()
            return new Promise<TResult1 | TResult2>(() => undefined)
          }
        })
      }
      const asker: ILogDestination = { name: 'asker', write: jest.fn() }
      const health = new DestinationHealth()
      health.markHealthy(destination, 'info')
      const stream = destinationToStream(destination, health)

      stream.write('entry\n')
      await new Promise((resolve) => setImmediate(resolve))

      expect(health.deliveredByHealthySink(asker, 'info')).toBe(false)

      settle?.()
      await new Promise((resolve) => setImmediate(resolve))

      expect(health.deliveredByHealthySink(asker, 'info')).toBe(true)
    })
  })

  describe('init health', () => {
    let stdoutSpy: jest.SpyInstance

    beforeEach(() => {
      stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    })

    afterEach(() => {
      stdoutSpy.mockRestore()
    })

    it(/*
     * A destination that failed onInit never became a live sink, so it must not be
     * written to — its write() may assume resources that were never acquired. The
     * multistream is wired before any onInit runs, so this check is the only place
     * the exclusion can happen.
     */
    'does not write to a destination that failed onInit', async () => {
      const destination: ILogDestination = { name: 'failed', write: jest.fn() }
      const health = new DestinationHealth()
      health.markHealthy({ name: 'other', write: jest.fn() }, 'info') // a healthy sink elsewhere
      health.markFailed(destination, 'info')
      const stream = destinationToStream(destination, health)

      await writeOnce(stream, 'entry\n')

      expect(destination.write).not.toHaveBeenCalled()
      expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it(/*
     * REGRESSION — the defect this whole mechanism exists for. With `destinations`
     * replacing the default stdout sink, a sole destination that fails onInit left
     * the application booting, running, exiting 0 and writing NOTHING anywhere.
     * When nothing initialized, the elected rescuer must emit the raw NDJSON.
     */
    'rescues the entry to stdout when no destination initialized', async () => {
      const destination: ILogDestination = { name: 'only', write: jest.fn() }
      const health = new DestinationHealth()
      health.markFailed(destination, 'info')
      const stream = destinationToStream(destination, health)

      await writeOnce(stream, '{"level":"info"}\n')

      expect(stdoutSpy).toHaveBeenCalledWith('{"level":"info"}\n')
      expect(destination.write).not.toHaveBeenCalled()
    })

    it(/*
     * Exactly one failed destination rescues an entry, so N failed sinks produce
     * one line rather than N duplicates of the same entry.
     */
    'rescues an entry once when several destinations failed', async () => {
      const first: ILogDestination = { name: 'first', write: jest.fn() }
      const second: ILogDestination = { name: 'second', write: jest.fn() }
      const health = new DestinationHealth()
      health.markFailed(first, 'info')
      health.markFailed(second, 'info')

      await writeOnce(destinationToStream(first, health), 'entry\n')
      await writeOnce(destinationToStream(second, health), 'entry\n')

      expect(stdoutSpy).toHaveBeenCalledTimes(1)
    })

    it(/*
     * The rescue must not become the crash it exists to prevent: stdout can be a
     * closed pipe (`node app | head`), and EPIPE there must be swallowed.
     */
    'survives stdout itself failing during a rescue', async () => {
      stdoutSpy.mockImplementation(() => {
        throw new Error('EPIPE')
      })
      const destination: ILogDestination = { name: 'only', write: jest.fn() }
      const health = new DestinationHealth()
      health.markFailed(destination, 'info')
      const stream = destinationToStream(destination, health)

      await expect(writeOnce(stream, 'entry\n')).resolves.toBeUndefined()
    })
  })
})
