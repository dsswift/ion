/**
 * ATV IPC handler validation: every renderer-supplied payload is checked
 * before any side effect, per the ipc-validation conventions. Handlers are
 * captured from a mocked ipcMain and invoked directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, onHandlers, writeSettingsMock, openAtvWindowMock, applyAtvActivationPolicyMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  writeSettingsMock: vi.fn(),
  openAtvWindowMock: vi.fn(),
  applyAtvActivationPolicyMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => onHandlers.set(channel, fn)),
  },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ state: { atvActiveTabId: 'active-tab', atvActiveProfileId: null } }))
vi.mock('../../atv-window-manager', () => ({
  openAtvWindow: openAtvWindowMock,
  applyAtvActivationPolicy: applyAtvActivationPolicyMock,
  isAtvWindowOpen: vi.fn(() => true),
}))
vi.mock('../../atv-state-cache', () => ({
  getAtvState: vi.fn(() => ({ agents: [], events: [], statusFields: null })),
}))
vi.mock('../../atv-theme-packs', () => ({
  listThemePacks: vi.fn(() => []),
  readPackBundle: vi.fn(() => null),
  readThemeAsset: vi.fn(() => null),
}))
vi.mock('../../settings-store', () => ({
  readSettings: vi.fn(() => ({ atvTheme: 'ion-works' })),
  writeSettings: writeSettingsMock,
  SETTINGS_DEFAULTS: { atvTheme: 'ion-works', atvPinned: false, atvZoom: 2, atvSeeds: {} },
}))

import { registerAtvIpc } from '../atv'
import { IPC } from '../../../shared/types'
import { readSettings } from '../../settings-store'

registerAtvIpc()

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

beforeEach(() => {
  writeSettingsMock.mockClear()
  applyAtvActivationPolicyMock.mockClear()
})

describe('atv:get-state validation', () => {
  it('serves the active tab when no tabId is passed', () => {
    const result = invoke(IPC.ATV_GET_STATE) as { activeTabId: string }
    expect(result.activeTabId).toBe('active-tab')
  })

  it('rejects malformed tab ids', () => {
    expect(invoke(IPC.ATV_GET_STATE, '../etc/passwd')).toBeNull()
    expect(invoke(IPC.ATV_GET_STATE, 'tab id with spaces')).toBeNull()
    expect(invoke(IPC.ATV_GET_STATE, 42 as unknown as string)).toBeNull()
  })
})

describe('atv:set-setting validation', () => {
  it('rejects keys outside the ATV allowlist', () => {
    expect(invoke(IPC.ATV_SET_SETTING, 'relayApiKey', 'steal')).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'themeMode', 'light')).toBe(false)
    expect(writeSettingsMock).not.toHaveBeenCalled()
  })

  it('validates per-key value shapes', () => {
    expect(invoke(IPC.ATV_SET_SETTING, 'atvZoom', 2.5)).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvZoom', 99)).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvPinned', 'true')).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvTheme', 'Bad Theme!')).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvSeed', 42)).toBe(false)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvSeed', 'x'.repeat(300))).toBe(false)
    expect(writeSettingsMock).not.toHaveBeenCalled()
  })

  it('persists valid values', () => {
    expect(invoke(IPC.ATV_SET_SETTING, 'atvZoom', 0)).toBe(true) // fit mode
    expect(invoke(IPC.ATV_SET_SETTING, 'atvZoom', 3)).toBe(true)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvSeed', 'my-office')).toBe(true)
    expect(invoke(IPC.ATV_SET_SETTING, 'atvSeed', '')).toBe(true) // reset to default
    expect(writeSettingsMock).toHaveBeenCalledTimes(4)
  })

  it('atvDockPresence: boolean-validated and re-applied live to the open window', () => {
    expect(invoke(IPC.ATV_SET_SETTING, 'atvDockPresence', 'on')).toBe(false)
    expect(applyAtvActivationPolicyMock).not.toHaveBeenCalled()
    expect(invoke(IPC.ATV_SET_SETTING, 'atvDockPresence', false)).toBe(true)
    // isAtvWindowOpen mocked true: the policy is re-applied for the open window.
    expect(applyAtvActivationPolicyMock).toHaveBeenCalledWith(true)
  })
})

describe('atv:read-theme-* validation', () => {
  it('rejects non-string pack ids and paths', () => {
    expect(invoke(IPC.ATV_READ_THEME_BUNDLE, 42)).toBeNull()
    expect(invoke(IPC.ATV_READ_THEME_ASSET, 'ion-works', 42)).toBeNull()
    expect(invoke(IPC.ATV_READ_THEME_ASSET, null, 'a.png')).toBeNull()
  })
})

describe('atv:open', () => {
  it('opens the window via the window manager', () => {
    const handler = onHandlers.get(IPC.ATV_OPEN)
    expect(handler).toBeDefined()
    handler!({})
    expect(openAtvWindowMock).toHaveBeenCalled()
  })
})

describe('atv:get-settings atvEnabled derivation', () => {
  it('returns atvEnabled: false when atvBeta is absent', () => {
    vi.mocked(readSettings).mockReturnValueOnce({ atvTheme: 'ion-works' })
    const result = invoke(IPC.ATV_GET_SETTINGS) as Record<string, unknown>
    expect(result.atvEnabled).toBe(false)
  })

  it('returns atvEnabled: true when atvBeta is true and policy permits', () => {
    vi.mocked(readSettings).mockReturnValueOnce({ atvTheme: 'ion-works', atvBeta: true })
    const result = invoke(IPC.ATV_GET_SETTINGS) as Record<string, unknown>
    expect(result.atvEnabled).toBe(true)
  })

  it('returns atvEnabled: false when atvBeta is true but overlay-only policy', () => {
    vi.mocked(readSettings).mockReturnValueOnce({ atvTheme: 'ion-works', atvBeta: true, surfacePolicy: 'overlay-only' })
    const result = invoke(IPC.ATV_GET_SETTINGS) as Record<string, unknown>
    expect(result.atvEnabled).toBe(false)
  })
})
