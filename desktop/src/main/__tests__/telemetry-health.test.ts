import { describe, it, expect, vi, beforeEach } from 'vitest'

const showMock = vi.fn()
vi.mock('electron', () => {
  class FakeNotification {
    show = showMock
    static isSupported() { return true }
  }
  return { Notification: FakeNotification }
})
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import {
  installTelemetryHealthConsumer,
  describeTelemetryHealth,
  telemetryHealthState,
  telemetryHealthNotificationsEnabled,
  __resetTelemetryHealthForTest,
  type TelemetryHealthEvent,
} from '../telemetry-health'

/** Minimal bridge stand-in that lets a test push events through. */
function fakeBridge() {
  let handler: ((key: string, event: TelemetryHealthEvent) => void) | undefined
  return {
    on: (_ev: string, cb: (key: string, event: TelemetryHealthEvent) => void) => { handler = cb },
    emit: (event: TelemetryHealthEvent) => handler?.('', event),
  }
}

const crossing = (pct: number, threshold: number): TelemetryHealthEvent => ({
  type: 'engine_telemetry_health',
  telemetryTarget: 'eventhub',
  telemetryQueuedEvents: 120,
  telemetryQueuedBytes: 5 * 1024 * 1024,
  telemetryPercentOfSoftWarn: pct,
  telemetryCrossedThreshold: threshold,
  telemetryHealthy: false,
  telemetryLastError: 'amqp: link detached',
})

describe('telemetry health consumer', () => {
  beforeEach(() => {
    showMock.mockClear()
    __resetTelemetryHealthForTest()
  })

  it('notifies on a threshold crossing', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit(crossing(52, 50))
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated engine events', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit({ type: 'engine_model_fallback' } as TelemetryHealthEvent)
    expect(showMock).not.toHaveBeenCalled()
  })

  it('does not announce a recovery the operator was never warned about', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit({
      type: 'engine_telemetry_health',
      telemetryTarget: 'eventhub',
      telemetryHealthy: true,
    })
    expect(showMock).not.toHaveBeenCalled()
  })

  it('announces recovery after a warning', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit(crossing(52, 50))
    showMock.mockClear()
    bridge.emit({
      type: 'engine_telemetry_health',
      telemetryTarget: 'eventhub',
      telemetryHealthy: true,
    })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('always notifies on a critical condition, even without a crossing', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit({
      type: 'engine_telemetry_health',
      telemetryTarget: 'eventhub',
      telemetryHealthy: false,
      telemetryCritical: true,
      telemetryLastError: 'no space left on device',
    })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('honours the enterprise off switch per event, not at install time', () => {
    const bridge = fakeBridge()
    let enabled = false
    installTelemetryHealthConsumer(bridge, { enabled: () => enabled })

    bridge.emit(crossing(52, 50))
    expect(showMock).not.toHaveBeenCalled()

    enabled = true
    bridge.emit(crossing(78, 75))
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('retains per-target state for a surface to render', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit(crossing(52, 50))

    const state = telemetryHealthState()
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({
      target: 'eventhub',
      queuedEvents: 120,
      healthy: false,
      critical: false,
    })
  })

  it('describes a critical condition as active loss, not a backlog', () => {
    const msg = describeTelemetryHealth({
      telemetryTarget: 'eventhub',
      telemetryCritical: true,
      telemetryLastError: 'no space left on device',
    })
    expect(msg).toContain('being lost now')
  })

  it('tells the operator a backlog is preserved, not dropped', () => {
    const msg = describeTelemetryHealth(crossing(52, 50))
    expect(msg).toContain('preserved')
    expect(msg).toContain('120 events queued')
  })

  const stuck = (ageMs: number, attempts: number): TelemetryHealthEvent => ({
    type: 'engine_telemetry_health',
    telemetryTarget: 'eventhub',
    telemetryQueuedEvents: 9,
    telemetryQueuedBytes: 48 * 1024 * 1024,
    telemetryPercentOfSoftWarn: 9,
    telemetryOldestAgeMs: ageMs,
    telemetryMaxAttempts: attempts,
    telemetryStuck: true,
    telemetryHealthy: false,
    telemetryLastError: 'too large for the batch',
  })

  it('notifies once when a small backlog becomes stuck, with no size crossing', () => {
    // The regression this pins: 48 MB at 9% of the threshold, failing for
    // hours, must reach the operator on age alone — and only on the
    // transition, not on every stuck report.
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit(stuck(20 * 60_000, 3))
    bridge.emit(stuck(25 * 60_000, 4))
    expect(showMock).toHaveBeenCalledTimes(1)
    expect(describeTelemetryHealth(stuck(20 * 60_000, 3))).toContain('stuck for 20 minutes')
    expect(describeTelemetryHealth(stuck(20 * 60_000, 3))).toContain('3 delivery attempts')
  })

  it('announces recovery after a stuck warning', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit(stuck(20 * 60_000, 3))
    showMock.mockClear()
    bridge.emit({ type: 'engine_telemetry_health', telemetryTarget: 'eventhub', telemetryHealthy: true })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('notifies on each increase in quarantined events and says the content is missing from the stream', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    const q = (n: number): TelemetryHealthEvent => ({
      type: 'engine_telemetry_health',
      telemetryTarget: 'eventhub',
      telemetryHealthy: true,
      telemetryQuarantinedEvents: n,
      telemetryQuarantinedBytes: n * 50_000_000,
    })
    bridge.emit(q(1))
    bridge.emit(q(1))
    bridge.emit(q(3))
    expect(showMock).toHaveBeenCalledTimes(2)
    const first = describeTelemetryHealth(q(1))
    expect(first).toContain('could not send 1 eventhub event')
    expect(first).toContain('missing from the stream')
    const afterFirst = { ...telemetryHealthState()[0], quarantinedEvents: 1 }
    expect(describeTelemetryHealth(q(3), afterFirst)).toContain('could not send 2 eventhub events')
  })

  it('retains stuck and quarantine state for a surface to render', () => {
    const bridge = fakeBridge()
    installTelemetryHealthConsumer(bridge)
    bridge.emit({ ...stuck(20 * 60_000, 3), telemetryQuarantinedEvents: 2, telemetryQuarantinedBytes: 100 })
    expect(telemetryHealthState()[0]).toMatchObject({ stuck: true, maxAttempts: 3, quarantinedEvents: 2, quarantinedBytes: 100 })
  })

  describe('telemetryHealthNotificationsEnabled (the enterprise seal production code actually reads)', () => {
    it('permits notifications when there is no enterprise policy', () => {
      expect(telemetryHealthNotificationsEnabled(null)).toBe(true)
      expect(telemetryHealthNotificationsEnabled(undefined)).toBe(true)
    })

    it('permits notifications when the policy does not set the flag', () => {
      expect(telemetryHealthNotificationsEnabled({})).toBe(true)
      expect(telemetryHealthNotificationsEnabled({ disableTelemetryHealthNotifications: false })).toBe(true)
    })

    it('suppresses notifications when the enterprise policy disables them', () => {
      expect(telemetryHealthNotificationsEnabled({ disableTelemetryHealthNotifications: true })).toBe(false)
    })
  })
})
