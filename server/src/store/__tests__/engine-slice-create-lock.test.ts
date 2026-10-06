/**
 * createConversationTab under the enterprise new-conversation lock: whatever
 * directory and profile a client asks for, a new conversation opens in the
 * locked directory on the locked profile. A restore keeps what it recorded.
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
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
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
  initialThinkingEffort: vi.fn(() => 'off' as const),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

// ─── Mock preferences ──────────────────────────────────────────────────────────
const mockPrefs = {
  addRecentBaseDirectory: vi.fn(),
  // createConversationTab reads this to resolve a default project directory;
  // without it Object.keys() throws and every case in this file fails before
  // reaching its assertion.
  projects: {} as Record<string, unknown>,
  engineProfiles: [] as any[],
  defaultBaseDirectory: '/home/user/projects',
  engineDefaultModel: null as string | null,
  preferredModel: null as string | null,
  defaultPermissionMode: 'auto' as string,
  planModelSplitEnabled: false,
  planModeModel: null as string | null,
}

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
}))

// ─── Mock clear-divider ────────────────────────────────────────────────────────
vi.mock('@ion/shared/clear-divider', () => ({
  formatSessionStartDivider: vi.fn(() => '── Session started at 00:00 ──'),
}))

// ─── Mock host-api ──────────────────────────────────────────────────────────
const mockIon = {
  createTab: vi.fn(),
  adoptTab: vi.fn(),
  engineStart: vi.fn(),
  ensureEngineSession: vi.fn(),
  setPermissionMode: vi.fn(),
}
const fsExists = vi.fn(async (_path: string) => ({ exists: true }))
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  fsExists: (path: string) => fsExists(path),
  createTab: (...args: any[]) => mockIon.createTab(...args),
  adoptTab: (...args: any[]) => mockIon.adoptTab(...args),
  engineStart: (...args: any[]) => mockIon.engineStart(...args),
  ensureEngineSession: (...args: any[]) => mockIon.ensureEngineSession(...args),
  setPermissionMode: (...args: any[]) => mockIon.setPermissionMode(...args),
}))

if (!(globalThis as any).crypto?.randomUUID) {
  ;(globalThis as any).crypto = (globalThis as any).crypto ?? {}
  ;(globalThis as any).crypto.randomUUID = () =>
    `${Math.random().toString(36).slice(2, 10)}-xxxx-4xxx-yxxx-${Math.random().toString(36).slice(2, 14)}`
}

let lock: { baseDirectory: string; engineProfileId: string } | null = null
vi.mock('../../new-conversation-lock', () => ({ activeNewConversationLock: () => lock }))

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


describe('createConversationTab — enterprise new-conversation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'locked-tab-id' })
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockPrefs.engineProfiles = [{ id: 'orion', name: 'orion', extensions: ['/x/orion'], defaultMode: 'auto' }]
    lock = { baseDirectory: '/data/home/jdoe/orion', engineProfileId: 'orion' }
  })

  it('opens a plain conversation requested elsewhere in the locked directory on the locked profile', async () => {
    const { state, set, get } = buildHarness()
    const tabId = await createConversationTabAction(set as any, get as any)('/data/home/jdoe')

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tab.workingDirectory).toBe('/data/home/jdoe/orion')
    expect(tab.engineProfileId).toBe('orion')
    expect(mockIon.engineStart).toHaveBeenCalledWith(tabId, expect.objectContaining({ profileId: 'orion', workingDirectory: '/data/home/jdoe/orion' }))
  })

  it('overrides a different profile and a worktree the client asked for', async () => {
    mockPrefs.engineProfiles.push({ id: 'other', name: 'other', extensions: ['/x/other'] })
    const { state, set, get } = buildHarness()
    const tabId = await createConversationTabAction(set as any, get as any)('/tmp/anywhere', { profileId: 'other', useWorktree: true })

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tab.engineProfileId).toBe('orion')
    expect(tab.worktree).toBeNull()
  })

  it('leaves a restore alone', async () => {
    const { state, set, get } = buildHarness()
    mockIon.adoptTab.mockResolvedValue({ tabId: 'restored' })
    const tabId = await createConversationTabAction(set as any, get as any)('/tmp/anywhere', { reuseTabId: 'restored', restoring: true })

    expect(state.tabs.find((t: any) => t.id === tabId).workingDirectory).toBe('/tmp/anywhere')
  })

  it('with no lock, honors the requested directory', async () => {
    lock = null
    const { state, set, get } = buildHarness()
    const tabId = await createConversationTabAction(set as any, get as any)('/tmp/anywhere')

    expect(state.tabs.find((t: any) => t.id === tabId).workingDirectory).toBe('/tmp/anywhere')
  })
})
