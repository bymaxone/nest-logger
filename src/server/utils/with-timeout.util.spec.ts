/**
 * Pins that the timeout helper settles with the work outcome or a timeout error at the deadline, clears its timer once the work settles, and that the timeout error is identifiable.
 * Layer: server/utils, tests.
 */
import { HookTimeoutError, withTimeout } from './with-timeout.util'

describe('withTimeout', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves with the value of a synchronous work', async () => {
    await expect(withTimeout(() => 7, 50)).resolves.toBe(7)
  })

  it('resolves with the value of a promise that settles in time', async () => {
    await expect(withTimeout(() => Promise.resolve('ok'), 50)).resolves.toBe('ok')
  })

  it('rejects with the rejection of the work', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom')
  })

  it('rejects with the throw of a synchronous work', async () => {
    await expect(
      withTimeout(() => {
        throw new Error('sync boom')
      }, 50)
    ).rejects.toThrow('sync boom')
  })

  it('rejects with a HookTimeoutError that names the deadline when the work does not settle', async () => {
    const error = await withTimeout(() => new Promise<void>(() => undefined), 20).catch(
      (cause: unknown) => cause
    )

    expect(error).toBeInstanceOf(HookTimeoutError)
    expect((error as HookTimeoutError).timeoutMs).toBe(20)
    expect((error as HookTimeoutError).message).toBe('did not settle within 20 ms')
  })

  it('clears its timer once the work settles', async () => {
    jest.useFakeTimers()

    await withTimeout(() => 1, 1000)

    expect(jest.getTimerCount()).toBe(0)
  })

  it('ignores a settlement that comes after the deadline', async () => {
    let release!: () => void
    const late = new Promise<void>((resolve) => {
      release = resolve
    })
    const outcome = withTimeout(() => late, 15).catch((cause: unknown) => cause)

    expect(await outcome).toBeInstanceOf(HookTimeoutError)
    release()
    await expect(outcome).resolves.toBeInstanceOf(HookTimeoutError)
  })

  it('keeps the process alive while the work is pending, so the deadline is the one that settles it', () => {
    const spy = jest.spyOn(globalThis, 'setTimeout')

    const pending = withTimeout(() => new Promise<void>(() => undefined), 20).catch(() => undefined)

    const timer = spy.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(true)
    spy.mockRestore()
    return pending
  })
})

describe('HookTimeoutError', () => {
  it('is an Error named for what it is, so a report can tell a deadline from a failure', () => {
    const error = new HookTimeoutError(30)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HookTimeoutError')
    expect(String(error)).toBe('HookTimeoutError: did not settle within 30 ms')
  })
})
