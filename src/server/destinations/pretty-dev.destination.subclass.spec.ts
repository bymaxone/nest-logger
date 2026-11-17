/**
 * Pins that a subclass of PrettyDevDestination cannot take over the steps of `onInit` by declaring a
 * method with the name of a step: the production refusal, the build of the transform and the error
 * written when it fails are not members of the class. The subclass is written without the type
 * check, as a JavaScript subclass is, so a method of that name is not a compile error.
 *
 * Layer: server/destinations, tests.
 */
import { PrettyDevDestination } from './pretty-dev.destination'

/** What the subclass's methods of the three names were called with. */
const called: string[] = []

/** A subclass, as untyped JavaScript would write it, that defines a method of each step's name. */
function overridingSubclass(): PrettyDevDestination {
  class Overriding extends PrettyDevDestination {}
  Object.assign(Overriding.prototype, {
    refuseInProduction: (): void => {
      called.push('refuseInProduction')
      throw new Error('overridden refusal')
    },
    buildTransform: (): never => {
      called.push('buildTransform')
      throw new Error('overridden build')
    },
    initFailure: (): Error => {
      called.push('initFailure')
      return new Error('overridden failure')
    }
  })
  return new Overriding({ view: { colorize: false } })
}

describe('PrettyDevDestination steps of onInit', () => {
  const originalEnv = process.env['NODE_ENV']

  beforeEach(() => {
    called.length = 0
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalEnv
  })

  /*
   * A member that a subclass defines with the name of a step must not run in its place: the steps
   * are not part of the class, so `onInit` builds the transform whatever the subclass declares.
   */
  it('builds the transform without calling a subclass method named after a step', async () => {
    process.env['NODE_ENV'] = 'development'
    const destination = overridingSubclass()

    await expect(destination.onInit()).resolves.toBeUndefined()
    await destination.onShutdown()

    expect(called).toEqual([])
  })

  it('refuses in production with its own message, not the one of a subclass method', async () => {
    process.env['NODE_ENV'] = 'production'
    const destination = overridingSubclass()

    await expect(destination.onInit()).rejects.toThrow(/refused in production/)

    expect(called).toEqual([])
  })
})
