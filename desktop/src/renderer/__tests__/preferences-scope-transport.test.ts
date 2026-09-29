// @vitest-environment jsdom
/**
 * A Personal preference and a Device setting are kept on this client and
 * never sent to a server. An Environment or Account setting goes to the
 * server. Before, all of them went to the local server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({ store: {} as Record<string, unknown>, set: vi.fn() }))
vi.mock('../host/host-instance', () => ({
  host: {
    deviceSettings: async () => ({ ...device.store }),
    setDeviceSetting: async (key: string, value: unknown) => { device.set(key, value); device.store[key] = value },
  },
}))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn() }))

import { isClientOwnedSetting, mergeClientSettings, partitionByOwner } from '../preferences-scope-transport'

beforeEach(() => { device.store = {}; device.set.mockClear() })

describe('partitionByOwner', () => {
  it('keeps the theme and a personal preference here, and sends server settings on', () => {
    expect(partitionByOwner({ selectedTheme: 'dusk', defaultThinkingEffort: 'high', preferredModel: 'm', inboxAutoSettleDays: 3, someLegacyKey: 1 })).toEqual({
      client: { selectedTheme: 'dusk', defaultThinkingEffort: 'high' },
      server: { preferredModel: 'm', inboxAutoSettleDays: 3, someLegacyKey: 1 },
    })
    expect(isClientOwnedSetting('soundEnabled')).toBe(true)
    expect(isClientOwnedSetting('inboxAutoSettleDays')).toBe(false)
  })
})

describe('mergeClientSettings', () => {
  it("adopts the server's earlier values on the first load, over the client store's defaults", async () => {
    // The client store answers with shipped defaults for keys nobody set, so
    // "the key is present" proves nothing. The marker decides.
    device.store = { selectedTheme: 'ion-dark' }
    const merged = await mergeClientSettings({ selectedTheme: 'dusk', preferredModel: 'm' })
    expect(merged).toEqual({ selectedTheme: 'dusk', preferredModel: 'm' })
    expect(device.set).toHaveBeenCalledWith('selectedTheme', 'dusk')
    expect(device.set).toHaveBeenCalledWith('clientSettingsAdopted', true)
    expect(device.set).not.toHaveBeenCalledWith('preferredModel', expect.anything())
  })

  it("prefers this client's value once adoption has happened, and never adopts twice", async () => {
    device.store = { clientSettingsAdopted: true, selectedTheme: 'dawn' }
    const merged = await mergeClientSettings({ selectedTheme: 'dusk', preferredModel: 'm' })
    expect(merged.selectedTheme).toBe('dawn')
    expect(device.set).not.toHaveBeenCalled()
  })

  it('never takes a server setting from the client store', async () => {
    device.store = { clientSettingsAdopted: true, preferredModel: 'stale-local' }
    const merged = await mergeClientSettings({ preferredModel: 'm' })
    expect(merged.preferredModel).toBe('m')
  })
})
