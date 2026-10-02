import { describe, expect, it, vi, beforeEach } from 'vitest'

const deps = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastDesktopSettingsSnapshot: vi.fn(),
  getRendererThemes: vi.fn(() => [{ id: 'pack-a' }]),
  startThemePackWatcher: vi.fn(),
  rescanThemePacks: vi.fn(() => true),
  listeners: [] as Array<() => void>,
}))
vi.mock('./broadcast', () => ({ broadcast: deps.broadcast }))
vi.mock('./settings-broadcast', () => ({ broadcastDesktopSettingsSnapshot: deps.broadcastDesktopSettingsSnapshot }))
vi.mock('./state', () => ({ state: { remoteTransport: null } }))
vi.mock('./theme-packs', () => ({
  buildThemeManifest: () => ({ themes: [], hash: 'h' }),
  getRendererThemes: deps.getRendererThemes,
  startThemePackWatcher: deps.startThemePackWatcher,
  rescanThemePacks: deps.rescanThemePacks,
  onThemePacksChanged: (cb: () => void) => { deps.listeners.push(cb); return () => { deps.listeners.splice(deps.listeners.indexOf(cb), 1) } },
}))
vi.mock('./logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { wireThemePackEvents } from './themes-wiring'
import { publishEnterprisePolicy } from './enterprise-policy-publish'

beforeEach(() => {
  deps.broadcast.mockClear()
  deps.broadcastDesktopSettingsSnapshot.mockClear()
  deps.startThemePackWatcher.mockClear()
  deps.rescanThemePacks.mockClear()
  deps.listeners.length = 0
})

describe('wireThemePackEvents', () => {
  it('starts the watcher and fans a pack-set change out as ion:themes-changed plus a settings snapshot', () => {
    const off = wireThemePackEvents()
    expect(deps.startThemePackWatcher).toHaveBeenCalledTimes(1)
    expect(deps.listeners).toHaveLength(1)
    deps.listeners[0]!()
    expect(deps.broadcast).toHaveBeenCalledWith('ion:themes-changed', [{ id: 'pack-a' }])
    expect(deps.broadcastDesktopSettingsSnapshot).toHaveBeenCalledWith('theme_packs_changed')
    off()
    expect(deps.listeners).toHaveLength(0)
  })

  it('re-reads the pack roots when the enterprise policy settles and when it changes', async () => {
    const off = wireThemePackEvents()
    expect(deps.rescanThemePacks).not.toHaveBeenCalled()

    publishEnterprisePolicy({ assetScopes: ['contractors'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.rescanThemePacks).toHaveBeenCalledTimes(1)
    expect(deps.startThemePackWatcher).toHaveBeenCalledTimes(2)

    publishEnterprisePolicy({ assetScopes: ['staff'] })
    expect(deps.rescanThemePacks).toHaveBeenCalledTimes(2)

    off()
    publishEnterprisePolicy({ assetScopes: [] })
    expect(deps.rescanThemePacks).toHaveBeenCalledTimes(2)
  })
})
