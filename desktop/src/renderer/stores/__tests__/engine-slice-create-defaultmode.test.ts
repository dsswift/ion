/**
 * engine-slice-create — defaultMode per engine profile
 *
 * Pins the contract that the engine profile's `defaultMode` field controls
 * the initial permissionMode of a new conversation tab:
 *
 *   - defaultMode:'plan'  → pane permissionMode 'plan' + setPermissionMode call
 *   - defaultMode:'auto'  → pane permissionMode 'auto' + no setPermissionMode
 *   - defaultMode absent  → same as 'auto' (fallback)
 *   - direct extensions (no profileId) → always 'auto'
 *
 * Extracted from engine-slice-create.test.ts to keep both files under the
 * 600-line cap. The mock setup is self-contained and mirrors the parent file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock session-store-helpers before import ──────────────────────────────────
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'local-id',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    lastMessagePreview: null,
    additionalDirs: [],
    permissionMode: 'auto',
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    hasFileActivity: false,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
  })),
  nextMsgId: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 8)}`),
  initialModelOverride: vi.fn(() => null),
  initialPermissionMode: vi.fn(() => 'auto'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

// ─── Mock preferences ──────────────────────────────────────────────────────────
const mockPrefs = {
  engineProfiles: [] as any[],
  tabGroupMode: 'none' as string,
  tabGroups: [] as any[],
  defaultBaseDirectory: '/home/user/projects',
  defaultTallConversation: false,
  engineDefaultModel: null as string | null,
  preferredModel: null as string | null,
  defaultPermissionMode: 'auto' as string,
  planModelSplitEnabled: false,
  planModeModel: null as string | null,
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
}))

// ─── Mock clear-divider ────────────────────────────────────────────────────────
vi.mock('../../../shared/clear-divider', () => ({
  formatSessionStartDivider: vi.fn(() => '── Session started at 00:00 ──'),
}))

// ─── Mock window.ion ──────────────────────────────────────────────────────────
const mockIon = {
  createTab: vi.fn(),
  adoptTab: vi.fn(),
  engineStart: vi.fn(),
  ensureEngineSession: vi.fn(),
  setPermissionMode: vi.fn(),
}
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = mockIon

if (!(globalThis as any).crypto?.randomUUID) {
  ;(globalThis as any).crypto = (globalThis as any).crypto ?? {}
  ;(globalThis as any).crypto.randomUUID = () =>
    `${Math.random().toString(36).slice(2, 10)}-xxxx-4xxx-yxxx-${Math.random().toString(36).slice(2, 14)}`
}

// ─── Import after mocks ────────────────────────────────────────────────────────
import { createConversationTabAction } from '../slices/engine-slice-create'

// ─── Harness ──────────────────────────────────────────────────────────────────
function buildHarness() {
  const state: any = {
    tabs: [],
    conversationPanes: new Map<string, any>(),
    activeTabId: null,
    tallViewTabId: null,
    terminalTallTabId: null,
    staticInfo: { homePath: '/home/user' },
  }

  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    if (patch.tabs !== undefined) state.tabs = patch.tabs
    if (patch.conversationPanes instanceof Map) state.conversationPanes = patch.conversationPanes
    if ('activeTabId' in patch) state.activeTabId = patch.activeTabId
    if ('tallViewTabId' in patch) state.tallViewTabId = patch.tallViewTabId
    if ('terminalTallTabId' in patch) state.terminalTallTabId = patch.terminalTallTabId
  }
  const get = () => state

  return { state, set, get }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createConversationTab — defaultMode per engine profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'mode-tab-id' })
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.setPermissionMode.mockResolvedValue(undefined)
  })

  it('engine tab with defaultMode:plan seeds permissionMode:plan on the main instance', async () => {
    mockPrefs.engineProfiles = [
      { id: 'plan-profile', name: 'Plan Profile', extensions: ['ext-a'], defaultMode: 'plan' },
    ]
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'plan-profile' })

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.permissionMode).toBe('plan')
  })

  it('engine tab with defaultMode:auto seeds permissionMode:auto on the main instance', async () => {
    mockPrefs.engineProfiles = [
      { id: 'auto-profile', name: 'Auto Profile', extensions: ['ext-a'], defaultMode: 'auto' },
    ]
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'auto-profile' })

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.permissionMode).toBe('auto')
  })

  it('engine tab with undefined defaultMode seeds permissionMode:auto (fallback)', async () => {
    mockPrefs.engineProfiles = [
      { id: 'no-mode-profile', name: 'No Mode', extensions: ['ext-a'] },
    ]
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'no-mode-profile' })

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.permissionMode).toBe('auto')
  })

  it('engine tab with explicit extensions (no profileId, __direct__ path) seeds permissionMode:auto', async () => {
    mockPrefs.engineProfiles = []
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { extensions: ['ext-direct'] })

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.permissionMode).toBe('auto')
  })

  it('engine tab with defaultMode:plan sends setPermissionMode(plan, session_start) after engineStart resolves', async () => {
    mockPrefs.engineProfiles = [
      { id: 'plan-profile', name: 'Plan Profile', extensions: ['ext-a'], defaultMode: 'plan' },
    ]
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'plan-profile' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockIon.setPermissionMode).toHaveBeenCalledWith('mode-tab-id', 'plan', 'session_start')
  })

  it('engine tab with defaultMode:auto does NOT send setPermissionMode', async () => {
    mockPrefs.engineProfiles = [
      { id: 'auto-profile', name: 'Auto Profile', extensions: ['ext-a'], defaultMode: 'auto' },
    ]
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'auto-profile' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockIon.setPermissionMode).not.toHaveBeenCalled()
  })

  it('engine tab with undefined defaultMode does NOT send setPermissionMode', async () => {
    mockPrefs.engineProfiles = [
      { id: 'no-mode-profile', name: 'No Mode', extensions: ['ext-a'] },
    ]
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'no-mode-profile' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockIon.setPermissionMode).not.toHaveBeenCalled()
  })
})
