import type { ILogDestination } from '../interfaces/log-destination.interface'

import { DestinationHealth } from './destination-health.service'

/** A destination stub — only identity matters to the health record. */
function makeDestination(name: string): ILogDestination {
  return { name, write: jest.fn() }
}

describe('DestinationHealth', () => {
  let health: DestinationHealth

  beforeEach(() => {
    health = new DestinationHealth()
  })

  it(/*
   * A destination nothing has been recorded about must be treated as live — the
   * fan-out consults this on every entry, and defaulting to "failed" would drop
   * every log written before onModuleInit runs.
   */
  'treats an unrecorded destination as live', () => {
    const destination = makeDestination('unrecorded')

    expect(health.isFailed(destination)).toBe(false)
    expect(health.shouldRescue(destination)).toBe(false)
  })

  it(/*
   * A failed destination must be identified by IDENTITY, not by name: two sinks
   * of the same type carry the same `name`, and excluding both because one failed
   * would silence a working sink.
   */
  'keys failures by identity rather than by name', () => {
    const failed = makeDestination('same-name')
    const healthy = makeDestination('same-name')
    health.markHealthy('info')
    health.markFailed(failed, 'info')

    expect(health.isFailed(failed)).toBe(true)
    expect(health.isFailed(healthy)).toBe(false)
  })

  it(/*
   * With at least one healthy destination there is somewhere to write, so no
   * rescue may happen — otherwise every entry would be duplicated onto stdout
   * beside the sink that is working fine.
   */
  'never rescues while any destination is healthy', () => {
    const failed = makeDestination('failed')
    health.markFailed(failed, 'info')
    health.markHealthy('info')

    expect(health.shouldRescue(failed)).toBe(false)
  })

  it(/*
   * The whole point of the record: when nothing initialized, one destination is
   * elected so entries reach stdout instead of vanishing.
   */
  'elects a rescuer when every destination failed', () => {
    const only = makeDestination('only')
    health.markFailed(only, 'info')

    expect(health.shouldRescue(only)).toBe(true)
  })

  it(/*
   * The rescuer is the failed destination with the LOWEST effective level, so the
   * rescue covers the union of what the consumer asked to see. Electing by
   * registration order instead would make output depend on array position: a
   * `warn` sink registered first would rescue at `warn` and silently drop the
   * `info` entries the second sink was configured to receive.
   */
  'elects the failed destination with the lowest level, not the first registered', () => {
    const quiet = makeDestination('quiet')
    const verbose = makeDestination('verbose')
    health.markFailed(quiet, 'error')
    health.markFailed(verbose, 'debug')

    expect(health.shouldRescue(verbose)).toBe(true)
    expect(health.shouldRescue(quiet)).toBe(false)
  })

  it(/*
   * A later destination at the SAME level must not steal the slot — the
   * comparison is strict, so ties fall back to registration order and the
   * election stays deterministic.
   */
  'breaks a level tie by registration order', () => {
    const first = makeDestination('first')
    const second = makeDestination('second')
    health.markFailed(first, 'info')
    health.markFailed(second, 'info')

    expect(health.shouldRescue(first)).toBe(true)
    expect(health.shouldRescue(second)).toBe(false)
  })

  it(/*
   * Exactly one rescuer may exist across any number of failures — N failed sinks
   * must rescue an entry once, not N times.
   */
  'elects exactly one rescuer however many destinations failed', () => {
    const destinations = ['a', 'b', 'c'].map(makeDestination)
    for (const destination of destinations) {
      health.markFailed(destination, 'info')
    }

    expect(destinations.filter((d) => health.shouldRescue(d))).toHaveLength(1)
  })

  it(/*
   * `hasHealthySink` is the fleet-wide fact the registry reads once, after every
   * onInit settled, to tell a destination holding pre-init entries whether anyone
   * else delivered them. `shouldRescue` answers a narrower per-write question, so
   * one cannot stand in for the other.
   */
  'reports whether any destination initialized', () => {
    const health = new DestinationHealth()
    expect(health.hasHealthySink()).toBe(false)

    health.markHealthy('info')

    expect(health.hasHealthySink()).toBe(true)
  })

  it(/*
   * REGRESSION — "a sink survived" is NOT "your entries were delivered".
   * `pino.multistream` filters per stream, so a healthy `error` sink never saw
   * the `info` boot entries a destination at `info` was holding. Discarding them
   * because something else was alive loses them, which is the failure the buffer
   * exists to prevent. Reported by Copilot against the first version of the
   * readiness hook, which carried only a boolean.
   */
  'reports delivery by LEVEL, not merely by a sink being alive', () => {
    const health = new DestinationHealth()
    health.markHealthy('error')

    // An `info` destination accepted entries the `error` sink never received.
    expect(health.deliveredByHealthySink('info')).toBe(false)
    // A `fatal` one accepted a subset of what the `error` sink took.
    expect(health.deliveredByHealthySink('fatal')).toBe(true)
    // Same level: a superset by definition.
    expect(health.deliveredByHealthySink('error')).toBe(true)
  })

  it(/*
   * With nothing live there is no delivery to claim, at any level — the flag must
   * not answer `true` off a stale lowest-level comparison.
   */
  'reports no delivery when nothing initialized', () => {
    const health = new DestinationHealth()

    expect(health.deliveredByHealthySink('fatal')).toBe(false)
    expect(health.hasHealthySink()).toBe(false)
  })

  it(/*
   * The LOWEST healthy level wins, so a later high-level sink cannot narrow what
   * an earlier permissive one already accepted.
   */
  'keeps the lowest level among several healthy sinks', () => {
    const health = new DestinationHealth()
    health.markHealthy('error')
    health.markHealthy('debug')

    expect(health.deliveredByHealthySink('info')).toBe(true)
  })

  it(/*
   * The same in the OTHER order, which is the direction that can regress: a
   * later, higher-level sink must not raise the recorded floor. Registering
   * `debug` then `error` has to keep `debug` — otherwise an `info` destination
   * would be told its entries were delivered by a sink that never saw them.
   */
  'does not let a later higher-level sink raise the floor', () => {
    const health = new DestinationHealth()
    health.markHealthy('debug')
    health.markHealthy('error')

    expect(health.deliveredByHealthySink('info')).toBe(true)
  })
})
