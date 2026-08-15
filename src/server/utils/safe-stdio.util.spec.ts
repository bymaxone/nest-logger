import { writeStderrSafely, writeStdoutSafely } from './safe-stdio.util'

describe('safe stdio', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // No listener cleanup between cases, deliberately. Each case captures the count
  // immediately before it acts and asserts a DELTA, so a handler left by an
  // earlier case is already inside its baseline. An earlier version did clean up,
  // by removing listeners through an untyped `.at(-1)` cast — and it broke the
  // very guarantee under test: the module then believed the stream was still
  // guarded while the listener was gone, which is the failure mode that made
  // `ensureGuarded` self-healing in the first place.

  it(/*
   * The ordinary path: the payload reaches the stream unchanged. A guard that
   * quietly swallowed real output would be worse than the crash it prevents.
   */
  'writes the payload through to stdout', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)

    writeStdoutSafely('entry\n')

    expect(spy).toHaveBeenCalledWith('entry\n')
  })

  it(/*
   * Same for stderr, which carries the destination failure reports.
   */
  'writes the payload through to stderr', () => {
    const spy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

    writeStderrSafely('report\n')

    expect(spy).toHaveBeenCalledWith('report\n')
  })

  it(/*
   * The SYNCHRONOUS half: a destroyed stream can throw from write() itself, and
   * that must not escape. This is the half a try/catch already covered — it is
   * asserted so a refactor cannot drop it while fixing the async half.
   */
  'swallows a synchronous throw from the stream', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('EPIPE')
    })

    expect(() => writeStdoutSafely('entry\n')).not.toThrow()
  })

  it(/*
   * REGRESSION — the ASYNCHRONOUS half, which is the whole reason this module
   * exists. A closed pipe reports EPIPE through the stream's 'error' event AFTER
   * write() has returned, so a try/catch never sees it and Node turns the emit
   * into an uncaught exception (measured: 0 default listeners, no sync throw,
   * process exits).
   *
   * Asserted by COUNTING the listener this module attaches, not by emitting and
   * checking nothing throws. The first version did the latter and proved nothing:
   * any ambient 'error' listener on the shared `process.stdout` — from jest, or
   * from a spec that ran earlier — makes `emit` harmless regardless of whether
   * this module attached anything. Mutation testing caught it: removing the
   * installation entirely left that test green.
   *
   * `isolateModules` gives a fresh module registry, so the module's own
   * "already guarded" memory is empty and the install path must run.
   */
  'attaches an error listener to stdout on first use', async () => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const before = process.stdout.listenerCount('error')

    await jest.isolateModulesAsync(async () => {
      const fresh = await import('./safe-stdio.util')
      fresh.writeStdoutSafely('entry\n')
    })

    expect(process.stdout.listenerCount('error')).toBe(before + 1)
  })

  it(/*
   * The handler must SWALLOW the error, not merely exist. `emit('error')` on an
   * EventEmitter with no listener re-throws — which is exactly how EPIPE reaches
   * Node's uncaught-exception path and kills the process.
   *
   * On its own this case would be weak evidence: any ambient listener on the
   * shared `process.stdout` makes the emit harmless regardless of what this
   * module did, which is how an earlier version of it passed while the
   * installation was mutated away. It is meaningful HERE because the case above
   * proves the listener is ours; this one proves ours does the right thing with
   * the event.
   */
  'swallows the error the handler receives', () => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    writeStdoutSafely('entry\n')

    expect(() => process.stdout.emit('error', new Error('EPIPE'))).not.toThrow()
  })

  it(/*
   * The handler is installed once per stream. Attaching one per write would trip
   * Node's max-listeners warning on a sustained outage — precisely when the
   * library is writing to a broken stream most often.
   */
  'attaches it only once, however many writes follow', async () => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const before = process.stdout.listenerCount('error')

    await jest.isolateModulesAsync(async () => {
      const fresh = await import('./safe-stdio.util')
      fresh.writeStdoutSafely('a\n')
      fresh.writeStdoutSafely('b\n')
      fresh.writeStdoutSafely('c\n')
    })

    expect(process.stdout.listenerCount('error')).toBe(before + 1)
  })
})
