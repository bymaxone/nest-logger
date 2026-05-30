import type { Writable } from 'node:stream'

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
  it(/*
   * A synchronous string write must reach the destination unchanged and complete
   * without error — the hot path for stdout-style destinations.
   */
  'forwards a synchronous string write to the destination', async () => {
    const destination: ILogDestination = { name: 'sync', write: jest.fn() }
    const stream = destinationToStream(destination)

    await writeOnce(stream, 'entry\n')

    expect(destination.write).toHaveBeenCalledWith('entry\n')
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
   * A rejected async write must surface as a stream error (callback receives it),
   * isolating the failure to this destination's wrapper.
   */
  'propagates a rejected async write as a stream error', async () => {
    const stream = destinationToStream({
      name: 'async-fail',
      write: jest.fn().mockRejectedValue(new Error('async-boom'))
    })

    await expect(writeOnce(stream, 'x\n')).rejects.toThrow('async-boom')
  })

  it(/*
   * A non-Error async rejection must be coerced into an Error so the stream
   * always emits a proper Error instance.
   */
  'coerces a non-Error async rejection into an Error', async () => {
    const stream = destinationToStream({
      name: 'async-weird',
      write: jest.fn().mockRejectedValue('string-rejection')
    })

    await expect(writeOnce(stream, 'x\n')).rejects.toThrow('string-rejection')
  })

  it(/*
   * A synchronous throw inside write must be caught and surfaced via the stream
   * callback rather than crashing the Pino producer.
   */
  'surfaces a synchronous throw as a stream error', async () => {
    const stream = destinationToStream({
      name: 'sync-fail',
      write: jest.fn(() => {
        throw new Error('sync-boom')
      })
    })

    await expect(writeOnce(stream, 'x\n')).rejects.toThrow('sync-boom')
  })

  it(/*
   * A non-Error synchronous throw must also be coerced into an Error.
   */
  'coerces a non-Error synchronous throw into an Error', async () => {
    const stream = destinationToStream({
      name: 'sync-weird',
      write: jest.fn(() => {
        throw 'string-throw'
      })
    })

    await expect(writeOnce(stream, 'x\n')).rejects.toThrow('string-throw')
  })
})
