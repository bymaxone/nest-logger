import { DefaultStdoutDestination } from './default-stdout.destination'

describe('DefaultStdoutDestination', () => {
  let writeSpy: jest.SpyInstance

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  it(/*
   * The destination's identity string is read by the registry for error
   * logs and metrics — locking it to `stdout-json` prevents silent rename.
   */
  'should expose the canonical name "stdout-json"', () => {
    const dest = new DefaultStdoutDestination()
    expect(dest.name).toBe('stdout-json')
  })

  it(/*
   * Writes must be forwarded to `process.stdout.write` byte-for-byte —
   * the destination is intentionally a thin sink with no formatting.
   */
  'should forward the payload to process.stdout.write', () => {
    const dest = new DefaultStdoutDestination()
    dest.write('{"level":30}\n')
    expect(writeSpy).toHaveBeenCalledWith('{"level":30}\n')
  })

  it(/*
   * Omitting `minLevel` must leave the property undefined so the registry
   * treats the destination as "accept everything". With
   * exactOptionalPropertyTypes the constructor branches must not set it.
   */
  'should default minLevel to undefined when no option is supplied', () => {
    const dest = new DefaultStdoutDestination()
    expect(dest.minLevel).toBeUndefined()
  })

  it(/*
   * Constructor must honour an explicit minLevel option so consumers can
   * route specific severities to dedicated destinations.
   */
  'should store the minLevel option when provided', () => {
    const dest = new DefaultStdoutDestination({ minLevel: 'warn' })
    expect(dest.minLevel).toBe('warn')
  })

  it(/*
   * Passing an empty options object must behave like omitting it — guards
   * the constructor's `= {}` default-parameter branch against regressions.
   */
  'should leave minLevel undefined when given an empty option bag', () => {
    const dest = new DefaultStdoutDestination({})
    expect(dest.minLevel).toBeUndefined()
  })
})
