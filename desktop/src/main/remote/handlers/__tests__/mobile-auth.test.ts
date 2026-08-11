import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
  broadcast: vi.fn(),
}))

vi.mock('../../../settings-store', () => ({
  readSettings: (...args: any[]) => mocks.readSettings(...args),
  writeSettings: (...args: any[]) => mocks.writeSettings(...args),
}))

vi.mock('../../../broadcast', () => ({
  broadcast: (...args: any[]) => mocks.broadcast(...args),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { handleReportMobileAuth } from '../mobile-auth'
import { IPC } from '../../../../shared/types'

function makePairedDevice(id: string) {
  return {
    id,
    name: `Device ${id}`,
    pairedAt: '2025-01-01T00:00:00Z',
    lastSeen: null,
    channelId: `ch-${id}`,
    sharedSecret: 'secret-abc',
  }
}

beforeEach(() => {
  mocks.readSettings.mockReset()
  mocks.writeSettings.mockReset()
  mocks.broadcast.mockReset()
})

describe('handleReportMobileAuth', () => {
  it('persists OIDC fields on the matched device', () => {
    const device = makePairedDevice('dev-1')
    mocks.readSettings.mockReturnValue({ pairedDevices: [device] })

    handleReportMobileAuth({
      type: 'desktop_report_mobile_auth',
      accountUsername: 'user@example.com',
      accountName: 'Test User',
      subject: 'sub-123',
      tenantId: 'tenant-abc',
      signedInAt: '2025-06-01T12:00:00Z',
    }, 'dev-1')

    expect(mocks.writeSettings).toHaveBeenCalledTimes(1)
    const saved = mocks.writeSettings.mock.calls[0][0]
    const savedDevice = saved.pairedDevices[0]
    expect(savedDevice.relayOidcAccountUsername).toBe('user@example.com')
    expect(savedDevice.relayOidcAccountName).toBe('Test User')
    expect(savedDevice.relayOidcSubject).toBe('sub-123')
    expect(savedDevice.relayOidcTenantId).toBe('tenant-abc')
    expect(savedDevice.relayOidcSignedInAt).toBe('2025-06-01T12:00:00Z')
  })

  it('broadcasts renderer-safe device without secrets', () => {
    const device = makePairedDevice('dev-1')
    mocks.readSettings.mockReturnValue({ pairedDevices: [device] })

    handleReportMobileAuth({
      type: 'desktop_report_mobile_auth',
      accountUsername: 'user@example.com',
      subject: 'sub-secret',
    }, 'dev-1')

    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    const [channel, rendererDevice] = mocks.broadcast.mock.calls[0]
    expect(channel).toBe(IPC.REMOTE_DEVICE_PAIRED)
    expect(rendererDevice.sharedSecret).toBeUndefined()
    expect(rendererDevice.relayOidcSubject).toBeUndefined()
    expect(rendererDevice.relayOidcAccountUsername).toBe('user@example.com')
  })

  it('ignores unknown device', () => {
    mocks.readSettings.mockReturnValue({ pairedDevices: [makePairedDevice('dev-1')] })

    handleReportMobileAuth({
      type: 'desktop_report_mobile_auth',
      accountUsername: 'user@example.com',
    }, 'unknown-device')

    expect(mocks.writeSettings).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('handles partial updates (only some fields present)', () => {
    const device = makePairedDevice('dev-1')
    mocks.readSettings.mockReturnValue({ pairedDevices: [device] })

    handleReportMobileAuth({
      type: 'desktop_report_mobile_auth',
      accountUsername: 'user@example.com',
    }, 'dev-1')

    const saved = mocks.writeSettings.mock.calls[0][0]
    const savedDevice = saved.pairedDevices[0]
    expect(savedDevice.relayOidcAccountUsername).toBe('user@example.com')
    expect(savedDevice.relayOidcAccountName).toBeUndefined()
    expect(savedDevice.relayOidcSubject).toBeUndefined()
  })
})
