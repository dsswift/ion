/**
 * The attention beacon (dock bounce + title prefix on a permission or plan
 * arriving while Studio is open but unfocused) rides the LOCAL server's
 * studio_event frames. It used to hook this process's own normalized-event
 * broadcast, which no longer has a producer (the Studio server owns the
 * engine bridge), so the beacon silently never fired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  maybeBeacon: vi.fn(),
  frameHandlers: [] as Array<(environmentId: string, frame: unknown) => void>,
  relayServerStartupReport: vi.fn(() => false),
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  dialog: {},
  BrowserWindow: { fromWebContents: vi.fn() },
}))
vi.mock('../connections/broker-instance', () => ({
  broker: {
    onFrame: (cb: (environmentId: string, frame: unknown) => void) => { mocks.frameHandlers.push(cb); return () => undefined },
    onPhase: vi.fn(),
    send: vi.fn(),
    allPhases: () => ({}),
  },
}))
vi.mock('../connections/environment-connect', () => ({ connectEnvironment: vi.fn(), disconnectEnvironment: vi.fn(), restartEnvironment: vi.fn() }))
vi.mock('../connections/pairing', () => ({ pairEnvironment: vi.fn() }))
vi.mock('../connections/transfer', () => ({ exportToFile: vi.fn(), importFromFile: vi.fn(), onTransferProgress: vi.fn(() => () => undefined) }))
vi.mock('../state', () => ({ state: { studioWindow: null } }))
vi.mock('../studio-window-manager', () => ({ openStudioWindow: vi.fn() }))
vi.mock('../device-settings', () => ({ readDeviceSettings: vi.fn(), updateDeviceSetting: vi.fn(), deviceSettingsFile: () => '/tmp/ion-test/desktop.json' }))
vi.mock('../catalog-watch', () => ({ watchCatalog: () => ({ stop: vi.fn(), note: vi.fn() }) }))
vi.mock('../env-cache', () => ({ writeEnvCache: vi.fn(), readEnvCache: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../startup-coordinator', () => ({ relayServerStartupReport: mocks.relayServerStartupReport }))
vi.mock('../studio-beacon', () => ({ maybeBeacon: mocks.maybeBeacon }))

import { registerStudioBridgeIpc } from '../ipc/studio-bridge'

describe('studio-bridge attention beacon', () => {
  beforeEach(() => {
    mocks.maybeBeacon.mockClear()
    mocks.frameHandlers.length = 0
    registerStudioBridgeIpc()
  })

  it('fires the beacon for a LOCAL normalized-event frame and for nothing else', () => {
    expect(mocks.frameHandlers).toHaveLength(1)
    const deliver = mocks.frameHandlers[0]
    const permission = { type: 'permission_request', questionId: 'q1' }
    deliver('local', { type: 'studio_event', channel: 'ion:normalized-event', payload: ['tab-1', permission] })
    expect(mocks.maybeBeacon).toHaveBeenCalledWith(permission)

    mocks.maybeBeacon.mockClear()
    // A remote Environment's events are not this desktop's dock to bounce.
    deliver('remote-1', { type: 'studio_event', channel: 'ion:normalized-event', payload: ['tab-2', permission] })
    // Other channels and other frame types carry nothing for the beacon.
    deliver('local', { type: 'studio_event', channel: 'ion:tab-status-change', payload: { tabId: 'tab-1', status: 'running' } })
    deliver('local', { type: 'studio_action_result', id: 'x', ok: true })
    expect(mocks.maybeBeacon).not.toHaveBeenCalled()
  })
})
