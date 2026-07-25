/**
 * Tests for enterprise new-tab policy projection in sendSync (#256).
 *
 * Verifies that `desktop_settings_snapshot` carries `newConversationPolicy` when
 * `getEnterprisePolicyNewConversationDefaults()` returns a locked policy, and that
 * the field is null when no enterprise config is present.
 *
 * We test sendSync's snapshot shape by capturing the `send` calls it makes
 * and asserting on the `desktop_settings_snapshot` payload.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getRemoteTabStatesMock: vi.fn().mockResolvedValue({ tabs: [], resourceManifest: {} }),
  readSettingsMock: vi.fn().mockReturnValue({
    defaultBaseDirectory: '/home/test',
    recentBaseDirectories: ['/home/test'],
    tabGroupMode: 'off',
    tabGroups: [],
    preferredModel: undefined,
    engineDefaultModel: undefined,
    engineProfiles: [],
  }),
  projectCurrentSettingsMock: vi.fn().mockReturnValue({ defaultEngineProfileId: '' }),
  projectableSchemamock: vi.fn().mockReturnValue([]),
  projectableGroupsMock: vi.fn().mockReturnValue([]),
  getEnterprisePolicyMock: vi.fn().mockResolvedValue(null),
  readRemoteDisplayMock: vi.fn().mockReturnValue(null),
}))

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      return {
        webContents: {
          executeJavaScript: vi.fn().mockResolvedValue({}),
        },
      }
    },
    get remoteTransport() {
      return { send: (...args: any[]) => mocks.sendMock(...args) }
    },
  },
  sessionPlane: {},
  engineBridge: {},
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  deviceFocusMap: new Map(),
  terminalScrollback: new Map(),
  modelCache: { models: [] },
  enterprisePolicyCache: { policy: null, newConversationDefaults: null },
}))

// Theme packs ride sendSync; mock the loader so this test never scans disk.
vi.mock('../theme-packs', () => ({
  buildThemeManifest: vi.fn(() => ({ themes: [], hash: 'empty' })),
  rescanThemePacks: vi.fn(() => false),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../remote/snapshot', () => ({
  getRemoteTabStates: (...args: any[]) => mocks.getRemoteTabStatesMock(...args),
}))

vi.mock('../settings-store', () => ({
  readSettings: (...args: any[]) => mocks.readSettingsMock(...args),
}))

vi.mock('../projectable-settings', () => ({
  projectCurrentSettings: () => mocks.projectCurrentSettingsMock(),
  projectableSchema: () => mocks.projectableSchemamock(),
  projectableGroups: () => mocks.projectableGroupsMock(),
}))

vi.mock('../engine-bridge-fs', () => ({
  getEnterprisePolicyNewConversationDefaults: () => mocks.getEnterprisePolicyMock(),
}))

vi.mock('../remote/handlers/display', () => ({
  readRemoteDisplay: () => mocks.readRemoteDisplayMock(),
}))

// ─── SUT ─────────────────────────────────────────────────────────────────────

import { sendSync } from '../remote/handlers/tabs-sync'
import { enterprisePolicyCache } from '../state'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function captureSettingsSnapshot(): Record<string, unknown> | undefined {
  const calls: any[] = mocks.sendMock.mock.calls
  const call = calls.find((c) => c[0]?.type === 'desktop_settings_snapshot')
  return call?.[0] as Record<string, unknown> | undefined
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sendSync: enterprise new-tab policy projection', () => {
  beforeEach(() => {
    mocks.sendMock.mockClear()
    mocks.getEnterprisePolicyMock.mockReset()
  })

  it('includes newConversationPolicy=null when no enterprise config is present', async () => {
    mocks.getEnterprisePolicyMock.mockResolvedValue(null)
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap).toBeDefined()
    expect(snap).toHaveProperty('type', 'desktop_settings_snapshot')
    expect(snap!.newConversationPolicy).toBeNull()
  })

  it('includes the locked policy when enterprise config sets locked=true', async () => {
    mocks.getEnterprisePolicyMock.mockResolvedValue({
      locked: true,
      baseDirectory: '/corp/workspace',
      engineProfileId: 'prof-enterprise',
    })
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap).toBeDefined()
    expect(snap!.newConversationPolicy).toEqual({
      locked: true,
      baseDirectory: '/corp/workspace',
      engineProfileId: 'prof-enterprise',
    })
  })

  it('includes locked=false policy when enterprise config is present but not locked', async () => {
    mocks.getEnterprisePolicyMock.mockResolvedValue({
      locked: false,
      baseDirectory: '/suggested/dir',
      engineProfileId: '',
    })
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap!.newConversationPolicy).toEqual({
      locked: false,
      baseDirectory: '/suggested/dir',
      engineProfileId: '',
    })
  })

  it('projects newConversationPolicy=null when getEnterprisePolicyNewConversationDefaults throws', async () => {
    // Engine IPC failure must not crash sendSync — policy is non-critical.
    mocks.getEnterprisePolicyMock.mockRejectedValue(new Error('engine unavailable'))
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    // Still sends the snapshot, policy is null (safe fallback).
    expect(snap).toBeDefined()
    expect(snap!.newConversationPolicy).toBeNull()
  })

  it('sends desktop_settings_snapshot as part of the sync payload', async () => {
    mocks.getEnterprisePolicyMock.mockResolvedValue(null)
    await sendSync(mocks.sendMock)
    const types = mocks.sendMock.mock.calls.map((c: any[]) => c[0]?.type)
    expect(types).toContain('desktop_settings_snapshot')
    expect(types).toContain('desktop_snapshot')
    expect(types).toContain('desktop_engine_profiles')
  })
})

describe('sendSync: enterprise theme policy projection', () => {
  beforeEach(() => {
    mocks.sendMock.mockClear()
    mocks.getEnterprisePolicyMock.mockReset()
    mocks.getEnterprisePolicyMock.mockResolvedValue(null)
    enterprisePolicyCache.policy = null
  })

  it('projects themePolicy=null when unmanaged', async () => {
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap!.themePolicy).toBeNull()
  })

  it('projects the locked theme policy from customFields[ion-desktop]', async () => {
    enterprisePolicyCache.policy = {
      customFields: { 'ion-desktop': { themePolicy: { themeId: 'acme-corp', locked: true } } },
    } as any
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap!.themePolicy).toEqual({ themeId: 'acme-corp', locked: true })
  })

  it('normalizes an absent locked flag to locked=false (managed default)', async () => {
    enterprisePolicyCache.policy = {
      customFields: { 'ion-desktop': { themePolicy: { themeId: 'ion-classic' } } },
    } as any
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap!.themePolicy).toEqual({ themeId: 'ion-classic', locked: false })
  })

  it('ignores a malformed themePolicy (missing themeId)', async () => {
    enterprisePolicyCache.policy = {
      customFields: { 'ion-desktop': { themePolicy: { locked: true } } },
    } as any
    await sendSync(mocks.sendMock)
    const snap = captureSettingsSnapshot()
    expect(snap!.themePolicy).toBeNull()
  })
})
