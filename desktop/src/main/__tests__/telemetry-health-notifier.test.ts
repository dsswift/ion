import { describe, it, expect, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

vi.mock('electron', () => ({ Notification: class { static isSupported() { return true } show() {} } }))
vi.mock('../env-cache', () => ({ readEnvCache: vi.fn(() => null) }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { notifyTelemetryHealth, telemetryHealthNotificationsEnabled } from '../telemetry-health-notifier'

const report = (notify: boolean): StudioFrame => ({ type: 'studio_event', channel: 'ion:telemetry-health', payload: { notify, message: 'eventhub is backlogged', state: { target: 'eventhub' } } })

describe('telemetry health notifier', () => {
  it('shows the local servers report when it says notify', () => {
    const show = vi.fn()
    notifyTelemetryHealth('local', report(true), { show, enabled: () => true })
    expect(show).toHaveBeenCalledWith('eventhub is backlogged')
  })

  it('ignores reports that are not worth a notification, other channels, and other environments', () => {
    const show = vi.fn()
    notifyTelemetryHealth('local', report(false), { show, enabled: () => true })
    notifyTelemetryHealth('grover', report(true), { show, enabled: () => true })
    notifyTelemetryHealth('local', { type: 'studio_event', channel: 'ion:themes-changed', payload: [] }, { show, enabled: () => true })
    expect(show).not.toHaveBeenCalled()
  })

  it('honours the enterprise off switch per report', () => {
    const show = vi.fn()
    let enabled = false
    notifyTelemetryHealth('local', report(true), { show, enabled: () => enabled })
    expect(show).not.toHaveBeenCalled()
    enabled = true
    notifyTelemetryHealth('local', report(true), { show, enabled: () => enabled })
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('reads the switch off the enterprise policy, on by default', () => {
    expect(telemetryHealthNotificationsEnabled(null)).toBe(true)
    expect(telemetryHealthNotificationsEnabled({ disableTelemetryHealthNotifications: true } as never)).toBe(false)
  })
})
