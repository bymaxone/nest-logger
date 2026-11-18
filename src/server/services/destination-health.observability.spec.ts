/**
 * Pins what the logger counts about itself: the fields cut or replaced by reason, the writes the
 * destinations refused, and the state of the fan-out, read without sending anything.
 *
 * Layer: server/services, tests.
 */
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { TruncationReason } from '../interfaces/logger-observability.interface'
import { DestinationHealth } from './destination-health.service'

const REASONS: readonly TruncationReason[] = ['max_entry_size', 'max_string_length']
const sink = (name: string): ILogDestination => ({ name, write: () => undefined })

describe('DestinationHealth as the observability view of the logger', () => {
  describe('the fields cut or replaced', () => {
    it.each(REASONS)('starts at zero for %s', (reason) => {
      expect(new DestinationHealth().truncatedTotal(reason)).toBe(0)
    })

    it('counts each reason on its own', () => {
      const health = new DestinationHealth()

      health.recordTruncation('max_entry_size')
      health.recordTruncation('max_entry_size')
      health.recordTruncation('max_string_length')

      expect(health.truncatedTotal('max_entry_size')).toBe(2)
      expect(health.truncatedTotal('max_string_length')).toBe(1)
    })
  })

  describe('the writes the destinations refused', () => {
    it('starts at zero', () => {
      expect(new DestinationHealth().destinationErrorTotal()).toBe(0)
    })

    it('sums the refused writes of every destination', () => {
      const health = new DestinationHealth()
      const a = sink('a')
      const b = sink('b')

      health.recordWriteFailure(a, 0)
      health.recordWriteFailure(a, 1)
      health.recordWriteFailure(b, 2)

      expect(health.destinationErrorTotal()).toBe(3)
    })

    it('does not count an entry dropped for want of queue room as a refused write', () => {
      const health = new DestinationHealth()

      health.recordDrop(sink('a'), 0)

      expect(health.destinationErrorTotal()).toBe(0)
    })
  })

  describe('the delivery state', () => {
    it('is empty before any destination has finished its init', () => {
      expect(new DestinationHealth().deliveryState()).toEqual({
        destinations: 0,
        failedInit: 0,
        writeFailing: 0,
        hasHealthySink: false
      })
    })

    it('counts the healthy and the failed destinations', () => {
      const health = new DestinationHealth()
      health.markHealthy(sink('a'), 'info')
      health.markHealthy(sink('b'), 'info')
      health.markFailed(sink('c'), 'info')

      expect(health.deliveryState()).toEqual({
        destinations: 3,
        failedInit: 1,
        writeFailing: 0,
        hasHealthySink: true
      })
    })

    it('has no healthy sink when every destination failed its init', () => {
      const health = new DestinationHealth()
      health.markFailed(sink('a'), 'info')

      expect(health.deliveryState()).toMatchObject({ failedInit: 1, hasHealthySink: false })
    })

    it('counts a destination that refused a write or had an entry dropped', () => {
      const health = new DestinationHealth()
      const a = sink('a')
      const b = sink('b')
      health.markHealthy(a, 'info')
      health.markHealthy(b, 'info')

      health.recordWriteFailure(a, 0)
      health.recordDrop(b, 0)

      expect(health.deliveryState()).toMatchObject({ writeFailing: 2, hasHealthySink: true })
    })
  })
})
