import { describe, it, expect, afterEach, vi } from 'vitest'
import { lastArrivalAt, markEventArrival, pruneEventLiveness } from '../event-liveness'

afterEach(() => {
  pruneEventLiveness([])
})

describe('event liveness', () => {
  it('records inbound event arrival time', () => {
    markEventArrival('tab-1', 123)

    expect(lastArrivalAt('tab-1')).toBe(123)
  })

  it('keeps the newest arrival for a tab', () => {
    markEventArrival('tab-1', 123)
    markEventArrival('tab-1', 456)

    expect(lastArrivalAt('tab-1')).toBe(456)
  })

  it('prunes closed-tab clocks', () => {
    markEventArrival('open', 123)
    markEventArrival('closed', 456)

    pruneEventLiveness(['open'])

    expect(lastArrivalAt('open')).toBe(123)
    expect(lastArrivalAt('closed')).toBeNull()
  })

  it('uses current time when no timestamp is supplied', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T21:58:28.650Z'))

    markEventArrival('tab-1')

    expect(lastArrivalAt('tab-1')).toBe(Date.now())
    vi.useRealTimers()
  })
})
