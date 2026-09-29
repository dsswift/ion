/**
 * FR-02 presence for remote (iOS) devices -- there is no studio `Connection`
 * for a device connected over `state.remoteTransport`, so its presence entry
 * is derived from `deviceFocusMap` (populated by the existing
 * `desktop_report_focus` command) cross-referenced against the paired-device
 * registry for the attributed principal and display name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { presenceSnapshot, _resetPresenceForTest } from '../presence'
import { deviceFocusMap, sessionPlane } from '../../state'
import type { PairedDevice } from '../../remote/protocol'

vi.mock('../../remote/paired-device-lookup', () => ({
  getPairedDeviceById: vi.fn(),
}))

afterEach(() => {
  _resetPresenceForTest()
  deviceFocusMap.clear()
  sessionPlane.removeAllListeners('tab-status-change')
  vi.restoreAllMocks()
})

describe('presenceSnapshot -- remote devices', () => {
  it('includes a remote device attributed to a principal', async () => {
    const { getPairedDeviceById } = await import('../../remote/paired-device-lookup')
    vi.mocked(getPairedDeviceById).mockReturnValue({
      id: 'device-1', name: "Alice's iPhone", principalSubject: 'oidc:alice',
    } as unknown as PairedDevice)
    deviceFocusMap.set('device-1', { tabId: 'tab-a', interceptEnabled: false })

    expect(presenceSnapshot()).toEqual([
      { subject: 'oidc:alice', displayName: "Alice's iPhone", focusedTabId: 'tab-a' },
    ])
  })

  it('omits a remote device with no attributed principal (no partitioning configured)', async () => {
    const { getPairedDeviceById } = await import('../../remote/paired-device-lookup')
    vi.mocked(getPairedDeviceById).mockReturnValue({ id: 'device-1', name: 'Unattributed iPad' } as unknown as PairedDevice)
    deviceFocusMap.set('device-1', { tabId: 'tab-a', interceptEnabled: false })

    expect(presenceSnapshot()).toEqual([])
  })

  it('omits a device the paired-device registry no longer knows about', async () => {
    const { getPairedDeviceById } = await import('../../remote/paired-device-lookup')
    vi.mocked(getPairedDeviceById).mockReturnValue(null)
    deviceFocusMap.set('device-1', { tabId: 'tab-a', interceptEnabled: false })

    expect(presenceSnapshot()).toEqual([])
  })
})
