/**
 * createConversationTab — the two guards that decide whether a conversation
 * may be created at all, and what a creation records.
 *
 * Split from `engine-slice-create.test.ts` at the file-size cap; same mocks,
 * same harness. These cover the machine boundary (a directory this host does
 * not have is refused) and the project-use counter the new-conversation
 * picker orders by.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock session-store-helpers before import (avoids Audio instantiation) ───
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

// ─── Mock preferences ─────────────────────────────────────────────────────────
const addRecentBaseDirectory = vi.fn()
const mockPrefs = {
  addRecentBaseDirectory,
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

// ─── Mock clear-divider ───────────────────────────────────────────────────────
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
  gitWorktreeRegistration: vi.fn(),
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
  gitWorktreeRegistration: (...args: any[]) => mockIon.gitWorktreeRegistration(...args),
}))

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

describe('createConversationTab — directory must exist on this machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsExists.mockResolvedValue({ exists: true })
    mockIon.createTab.mockResolvedValue({ tabId: 'real-tab-id-abc123' })
    mockIon.adoptTab.mockResolvedValue({ tabId: 'restored-tab' })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.gitWorktreeRegistration.mockResolvedValue({ registration: null })
    mockPrefs.engineProfiles = []
  })

  // A client connected to several servers once sent this server a worktree
  // path that lives on another machine. The tab was created anyway and filed
  // under a project this machine does not have.
  it('refuses a new tab for a directory this machine does not have, and creates nothing', async () => {
    fsExists.mockResolvedValue({ exists: false })
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await expect(createConversationTab('/Users/other/.ion/worktrees/ion-abc')).rejects.toThrow(/does not have/)

    expect(fsExists).toHaveBeenCalledWith('/Users/other/.ion/worktrees/ion-abc')
    expect(state.tabs).toHaveLength(0)
    expect(mockIon.createTab).not.toHaveBeenCalled()
    expect(mockIon.ensureEngineSession).not.toHaveBeenCalled()
  })

  it('still restores a persisted tab whose directory has since been removed', async () => {
    fsExists.mockResolvedValue({ exists: false })
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/gone/project', { reuseTabId: 'restored-tab' })

    expect(tabId).toBe('restored-tab')
    expect(state.tabs).toHaveLength(1)
  })
})

describe('createConversationTab — recording project use', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsExists.mockResolvedValue({ exists: true })
    mockIon.createTab.mockResolvedValue({ tabId: 'real-tab-id-abc123' })
    mockIon.adoptTab.mockResolvedValue({ tabId: 'restored-tab' })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.gitWorktreeRegistration.mockResolvedValue({ registration: null })
    mockPrefs.engineProfiles = []
  })

  // The new-conversation picker orders projects by this count, and it creates
  // through here rather than through createTabInDirectory. Before this, the
  // picker's own conversations were never counted.
  it('records one use of the project for a new conversation', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project')

    expect(addRecentBaseDirectory).toHaveBeenCalledTimes(1)
    expect(addRecentBaseDirectory).toHaveBeenCalledWith('/tmp/project')
  })

  // A worktree conversation belongs to the project it was cut from, which is
  // what the picker lists -- never the worktree path.
  it('records the project, not the working directory, when they differ', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project/sub', { projectDirectory: '/tmp/project' })

    expect(addRecentBaseDirectory).toHaveBeenCalledWith('/tmp/project')
  })

  it('does not count a restore: it reopens what was already counted', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { reuseTabId: 'restored-tab' })

    expect(addRecentBaseDirectory).not.toHaveBeenCalled()
  })

  it('does not count a restore of a record saved before ids were persisted', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { restoring: true })

    expect(addRecentBaseDirectory).not.toHaveBeenCalled()
  })

  it('does not count a creation this machine refused', async () => {
    fsExists.mockResolvedValue({ exists: false })
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await expect(createConversationTab('/elsewhere/project')).rejects.toThrow(/does not have/)

    expect(addRecentBaseDirectory).not.toHaveBeenCalled()
  })
})
