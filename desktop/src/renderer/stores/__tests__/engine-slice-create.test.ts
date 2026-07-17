/**
 * engine-slice-create — unified createConversationTab tests
 *
 * Pins the Phase 2 conversation-unification (#256) contract:
 *
 *   1. Both plain (no extensions) and engine (with extensions) tabs go
 *      through the same async createConversationTab path.
 *   2. Both receive a real engine-backed tab ID via window.ion.createTab().
 *   3. Both produce a single `main` conversationPane instance
 *      (MAIN_INSTANCE_ID sentinel), seeded with a session-start divider.
 *   4. Extension presence is derived from engineProfileId (via tabHasExtensions),
 *      NOT from which entry point (createConversationTab vs createTabInDirectory) was used.
 *   5. The session key for all tabs is the bare `tabId`.
 *   6. Plain tabs call window.ion.setPermissionMode; engine tabs call
 *      window.ion.engineStart with the resolved extensions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tabHasExtensions } from '../../../shared/tab-predicates'

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

// ─── Mock preferences ─────────────────────────────────────────────────────────
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

// ─── Mock clear-divider ───────────────────────────────────────────────────────
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
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'

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

describe('createConversationTab — plain tab (no extensions)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'real-tab-id-abc123' })
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.setPermissionMode.mockResolvedValue(undefined)
    mockPrefs.engineProfiles = []
  })

  it('gets a real engine-backed tab ID from window.ion.createTab()', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    expect(mockIon.createTab).toHaveBeenCalledOnce()
    expect(tabId).toBe('real-tab-id-abc123')
  })

  it('produces a plain tab (tabHasExtensions=false, no extensions)', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project')

    const tab = state.tabs.find((t: any) => t.id === 'real-tab-id-abc123')
    expect(tab).toBeDefined()
    expect(tabHasExtensions(tab)).toBe(false)
  })

  it('produces a single main pane with MAIN_INSTANCE_ID', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    const pane = state.conversationPanes.get(tabId)
    expect(pane).toBeDefined()
    expect(pane.instances).toHaveLength(1)
    expect(pane.instances[0].id).toBe(MAIN_INSTANCE_ID)
    expect(pane.activeInstanceId).toBe(MAIN_INSTANCE_ID)
  })

  it('seeds a session-start divider as the first message', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.messages).toHaveLength(1)
    expect(inst.messages[0].role).toBe('system')
    expect(inst.messages[0].content).toMatch(/session started/i)
    expect(inst.messageCount).toBe(1)
  })

  it('pre-starts the engine session via ensureEngineSession (not engineStart) for plain tabs', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project')
    await Promise.resolve()
    await Promise.resolve()

    // Plain tabs pre-start the session so the engine mints the conversation id
    // at creation time (rather than waiting for the first prompt). The permission
    // mode flows through ensureEngineSession's permissionMode arg, so the prior
    // setPermissionMode-only call is gone.
    expect(mockIon.ensureEngineSession).toHaveBeenCalledOnce()
    expect(mockIon.ensureEngineSession).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'real-tab-id-abc123', workingDirectory: '/tmp/project' }),
    )
    expect(mockIon.engineStart).not.toHaveBeenCalled()
  })

  it('captures the engine-minted conversation id onto the tab and main instance at creation', async () => {
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true, conversationId: '1780000000000-aaaaaaaaaaaa' })
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')
    await Promise.resolve()
    await Promise.resolve()

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tab.conversationId).toBe('1780000000000-aaaaaaaaaaaa')
    expect(tab.lastKnownSessionId).toBe('1780000000000-aaaaaaaaaaaa')
    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.conversationIds).toContain('1780000000000-aaaaaaaaaaaa')
  })

  it('instance id is main (bare tabId is the session key)', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    const pane = state.conversationPanes.get(tabId)
    const instanceId = pane.instances[0].id
    expect(instanceId).toBe('main')
  })
})

describe('createConversationTab — engine tab (with profileId)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'engine-tab-id-xyz' })
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.setPermissionMode.mockResolvedValue(undefined)
    mockPrefs.engineProfiles = [
      { id: 'profile-1', name: 'My Extension', extensions: ['ext-a', 'ext-b'] },
    ]
  })

  it('gets a real engine-backed tab ID from window.ion.createTab()', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'profile-1' })

    expect(mockIon.createTab).toHaveBeenCalledOnce()
    expect(tabId).toBe('engine-tab-id-xyz')
  })

  it('produces an engine tab (tabHasExtensions=true) when extensions are non-empty', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'profile-1' })

    const tab = state.tabs.find((t: any) => t.id === 'engine-tab-id-xyz')
    expect(tab).toBeDefined()
    expect(tabHasExtensions(tab)).toBe(true)
    expect(tab.pillIcon).toBe('lightning')
    expect(tab.permissionMode).toBe('auto')
  })

  // Unified title seeding: an extension tab is born with the SAME neutral
  // placeholder as a plain tab, NOT the profile name. Seeding the profile name
  // ('My Extension') here would diverge the two tab kinds at birth and break
  // unified titling — the send-time + AI-titling paths key off this placeholder
  // to replace it with the first prompt. Harness identity is shown by the
  // harness badge (TabStripTabPill), derived live from engineProfileId, so the
  // profile name is not lost. Regression direction: restore the profile-name
  // seed and this assertion goes red.
  it('seeds the neutral "New Tab" title (not the profile name) for an extension tab', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'profile-1' })

    const tab = state.tabs.find((t: any) => t.id === 'engine-tab-id-xyz')
    expect(tab.title).toBe('New Tab')
  })

  it('produces a single main pane with MAIN_INSTANCE_ID', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'profile-1' })

    const pane = state.conversationPanes.get(tabId)
    expect(pane.instances).toHaveLength(1)
    expect(pane.instances[0].id).toBe(MAIN_INSTANCE_ID)
    expect(pane.activeInstanceId).toBe(MAIN_INSTANCE_ID)
  })

  it('seeds a session-start divider as the first message', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'profile-1' })

    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.messages).toHaveLength(1)
    expect(inst.messages[0].role).toBe('system')
    expect(inst.messages[0].content).toMatch(/session started/i)
  })

  it('calls window.ion.engineStart (not setPermissionMode) for engine tabs', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    await createConversationTab('/tmp/project', { profileId: 'profile-1' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockIon.engineStart).toHaveBeenCalledOnce()
    expect(mockIon.setPermissionMode).not.toHaveBeenCalled()
  })

  it('calls engineStart with bare tabId key and profile extensions', async () => {
    const { set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'profile-1' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockIon.engineStart).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        profileId: 'profile-1',
        extensions: ['ext-a', 'ext-b'],
        workingDirectory: '/tmp/project',
      }),
    )
  })

  it('captures the engine-minted conversation id onto the tab and main instance at creation', async () => {
    mockIon.engineStart.mockResolvedValue({ ok: true, conversationId: '1780000000001-bbbbbbbbbbbb' })
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'profile-1' })
    await Promise.resolve()
    await Promise.resolve()

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tab.conversationId).toBe('1780000000001-bbbbbbbbbbbb')
    expect(tab.lastKnownSessionId).toBe('1780000000001-bbbbbbbbbbbb')
    const inst = state.conversationPanes.get(tabId)?.instances[0]
    expect(inst.conversationIds).toContain('1780000000001-bbbbbbbbbbbb')
  })
})

describe('createConversationTab — extension presence derived from engineProfileId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'tab-id' })
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.setPermissionMode.mockResolvedValue(undefined)
    mockPrefs.engineProfiles = [
      { id: 'empty-profile', name: 'Empty', extensions: [] },
      { id: 'full-profile', name: 'Full', extensions: ['ext-x'] },
    ]
  })

  it('is FALSE for a profile with empty extensions (entry point does not matter)', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    // profileId specified (engine "entry point") but extensions list is empty
    const tabId = await createConversationTab('/tmp/project', { profileId: 'empty-profile' })
    await Promise.resolve()
    await Promise.resolve()

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tabHasExtensions(tab)).toBe(false)
    expect(mockIon.ensureEngineSession).toHaveBeenCalledOnce()
    expect(mockIon.engineStart).not.toHaveBeenCalled()
  })

  it('is TRUE for an explicit non-empty extensions list (no profileId)', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { extensions: ['ext-direct'] })
    await Promise.resolve()
    await Promise.resolve()

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tabHasExtensions(tab)).toBe(true)
    expect(mockIon.engineStart).toHaveBeenCalledOnce()
  })

  it('is TRUE for a profile with extensions', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project', { profileId: 'full-profile' })

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tabHasExtensions(tab)).toBe(true)
  })

  it('explicit empty extensions list overrides profile extensions (plain tab)', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    // Profile has extensions, but caller passes explicit empty list
    const tabId = await createConversationTab('/tmp/project', {
      profileId: 'full-profile',
      extensions: [],
    })
    await Promise.resolve()
    await Promise.resolve()

    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tabHasExtensions(tab)).toBe(false)
    expect(mockIon.ensureEngineSession).toHaveBeenCalledOnce()
  })
})

describe('createConversationTab — IPC fallback', () => {
  it('uses a local UUID fallback when window.ion.createTab() throws', async () => {
    vi.clearAllMocks()
    mockIon.createTab.mockRejectedValue(new Error('IPC offline'))
    mockIon.setPermissionMode.mockResolvedValue(undefined)

    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    expect(tabId).toBeTruthy()
    // Must not be the mocked resolved value
    expect(tabId).not.toBe('real-tab-id-abc123')
    // Tab must still be in state with the fallback id
    const tab = state.tabs.find((t: any) => t.id === tabId)
    expect(tab).toBeDefined()
    // Pane must be seeded
    const pane = state.conversationPanes.get(tabId)
    expect(pane?.instances[0]?.id).toBe(MAIN_INSTANCE_ID)
  })
})

// ─── reuseTabId (restore path, Option A root-cause fix) ───────────────────────
//
// The restore path threads the persisted, durable tabId into
// createConversationTab via reuseTabId so the session key is INVARIANT across
// restarts. Without this, each restart minted a fresh tabId → new session key →
// engine binding miss → empty conversation minted → history fragmented across
// disjoint files. These tests pin that reuseTabId adopts the supplied id (never
// mints) and that the absence of reuseTabId keeps the mint path intact.
describe('createConversationTab — reuseTabId (restore)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIon.createTab.mockResolvedValue({ tabId: 'freshly-minted-id' })
    mockIon.adoptTab.mockImplementation(async (id: string) => ({ tabId: id }))
    mockIon.engineStart.mockResolvedValue({ ok: true })
    mockIon.ensureEngineSession.mockResolvedValue({ ok: true })
    mockIon.setPermissionMode.mockResolvedValue(undefined)
    mockPrefs.engineProfiles = []
  })

  it('adopts the persisted id and never mints when reuseTabId is supplied', async () => {
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const persistedId = 'persisted-tab-deadbeef'
    const tabId = await createConversationTab('/tmp/project', { reuseTabId: persistedId })

    // The returned/stored id is the persisted one — identity is invariant.
    expect(tabId).toBe(persistedId)
    expect(mockIon.adoptTab).toHaveBeenCalledWith(persistedId)
    // The mint path must NOT run on the restore path.
    expect(mockIon.createTab).not.toHaveBeenCalled()
    const tab = state.tabs.find((t: any) => t.id === persistedId)
    expect(tab).toBeDefined()
  })

  it('falls back to the supplied id when adoptTab throws', async () => {
    mockIon.adoptTab.mockRejectedValue(new Error('IPC offline'))
    const { state, set, get } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const persistedId = 'persisted-tab-offline'
    const tabId = await createConversationTab('/tmp/project', { reuseTabId: persistedId })

    // Even on adopt failure the identity stays the persisted id — the renderer
    // pane is the source of truth for tab identity.
    expect(tabId).toBe(persistedId)
    expect(mockIon.createTab).not.toHaveBeenCalled()
    expect(state.tabs.find((t: any) => t.id === persistedId)).toBeDefined()
  })

  it('mints (does not adopt) when reuseTabId is absent — brand-new tab path intact', async () => {
    const { get, set } = buildHarness()
    const createConversationTab = createConversationTabAction(set as any, get as any)

    const tabId = await createConversationTab('/tmp/project')

    expect(tabId).toBe('freshly-minted-id')
    expect(mockIon.createTab).toHaveBeenCalledOnce()
    expect(mockIon.adoptTab).not.toHaveBeenCalled()
  })
})

// defaultMode per engine profile tests live in engine-slice-create-defaultmode.test.ts
// (extracted to keep both files under the 600-line cap)
