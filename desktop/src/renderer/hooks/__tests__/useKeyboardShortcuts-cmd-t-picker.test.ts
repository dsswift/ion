/**
 * useKeyboardShortcuts — Cmd+T / Cmd+Shift+T show-picker dispatch
 *
 * Pins the fix for Cmd+T / Cmd+Shift+T doing nothing when the resolved
 * action is 'show-picker' (State 3: engine profiles exist, no default set).
 *
 * Before the fix, executeNewConversationAction returned 'show-picker' and
 * the keyboard handler discarded that return value, so nothing happened.
 *
 * After the fix the routing logic is in the exported
 * handleNewConversationShortcut() function, which is independently testable:
 *
 *   - 'show-picker' return → dispatchFn receives a CustomEvent of type
 *     'ion:open-new-conversation-picker' with detail.dir = the target dir.
 *   - 'plain' → createTabInDirectory called directly; dispatchFn NOT called
 *     with the picker event.
 *   - 'profile' → createConversationTab called; dispatchFn NOT called.
 *   - 'locked' → createConversationTab (or createTabInDirectory) called;
 *     dispatchFn NOT called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Store mocks -------------------------------------------------------

let sessionState: any
let prefState: any

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => sessionState },
  editorDirForTab: (tab: any) => tab?.workingDirectory ?? '',
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefState },
}))

vi.mock('../../preferences-types', async () => {
  const actual = await vi.importActual<any>('../../preferences-types')
  return actual
})

vi.mock('../../../shared/tab-predicates', () => ({
  tabHasExtensions: () => false,
}))

// new-conversation-routing: use the real module (pure logic, no deps).
vi.mock('../../components/new-conversation-routing', async () => {
  return vi.importActual('../../components/new-conversation-routing')
})

// ---- Shared state ------------------------------------------------------

function makeTab(id: string, workingDirectory = '/projects/ion') {
  return { id, workingDirectory, status: 'idle', title: 'Test', customTitle: null, pillColor: null, pillIcon: null, groupId: null, hasChosenDirectory: true, engineProfileId: null, worktreeRepoPath: null }
}

beforeEach(() => {
  vi.clearAllMocks()

  sessionState = {
    tabs: [makeTab('tab1')],
    activeTabId: 'tab1',
    fileEditorFocused: false,
    fileEditorOpenDirs: new Set(),
    fileEditorStates: new Map(),
    createTabInDirectory: vi.fn().mockResolvedValue('new-tab-id'),
    createConversationTab: vi.fn().mockResolvedValue('new-tab-id'),
  }

  prefState = {
    engineProfiles: [],
    defaultEngineProfileId: '',
    enterpriseNewConversationDefaults: null,
    defaultBaseDirectory: '/home/user',
    editorFontSize: 14,
    dataViewFontSize: 13,
    setEditorFontSize: vi.fn(),
    setDataViewFontSize: vi.fn(),
  }
})

// ---- Helper: captured dispatch events ----------------------------------

function makeDispatch() {
  const events: Array<{ type: string; detail: any }> = []
  const dispatchFn = (e: Event) => {
    events.push({ type: e.type, detail: (e as CustomEvent).detail })
  }
  return { dispatchFn, events }
}

// ---- Tests: handleNewConversationShortcut() ----------------------------

describe('handleNewConversationShortcut — show-picker path', () => {
  it('dispatches ion:open-new-conversation-picker when action is show-picker', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    // State 3: profiles exist, no default
    prefState.engineProfiles = [{ id: 'p1', name: 'Orion', extensions: ['ext/p1'] }]
    prefState.defaultEngineProfileId = ''

    const { dispatchFn, events } = makeDispatch()
    handleNewConversationShortcut('/home/user', 'Cmd+T', dispatchFn)

    const pickerEvent = events.find((e) => e.type === 'ion:open-new-conversation-picker')
    expect(pickerEvent).toBeDefined()
    expect(pickerEvent?.detail?.dir).toBe('/home/user')
    // No tab should be created
    expect(sessionState.createTabInDirectory).not.toHaveBeenCalled()
    expect(sessionState.createConversationTab).not.toHaveBeenCalled()
  })

  it('passes the dir from Cmd+Shift+T (active tab workingDirectory)', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    prefState.engineProfiles = [{ id: 'p1', name: 'Orion', extensions: ['ext/p1'] }]
    prefState.defaultEngineProfileId = ''

    const { dispatchFn, events } = makeDispatch()
    handleNewConversationShortcut('/projects/ion', 'Cmd+Shift+T', dispatchFn)

    const pickerEvent = events.find((e) => e.type === 'ion:open-new-conversation-picker')
    expect(pickerEvent).toBeDefined()
    expect(pickerEvent?.detail?.dir).toBe('/projects/ion')
  })
})

describe('handleNewConversationShortcut — plain path (no profiles)', () => {
  it('creates a tab directly and does NOT dispatch the picker event', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    prefState.engineProfiles = []
    prefState.defaultEngineProfileId = ''

    const { dispatchFn, events } = makeDispatch()
    handleNewConversationShortcut('/home/user', 'Cmd+T', dispatchFn)

    const pickerEvent = events.find((e) => e.type === 'ion:open-new-conversation-picker')
    expect(pickerEvent).toBeUndefined()
    expect(sessionState.createTabInDirectory).toHaveBeenCalledWith('/home/user')
  })
})

describe('handleNewConversationShortcut — profile path (default set)', () => {
  it('creates a conversation tab with the default profileId and does NOT dispatch the picker', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    prefState.engineProfiles = [{ id: 'p1', name: 'Orion', extensions: ['ext/p1'] }]
    prefState.defaultEngineProfileId = 'p1'

    const { dispatchFn, events } = makeDispatch()
    handleNewConversationShortcut('/home/user', 'Cmd+T', dispatchFn)

    const pickerEvent = events.find((e) => e.type === 'ion:open-new-conversation-picker')
    expect(pickerEvent).toBeUndefined()
    expect(sessionState.createConversationTab).toHaveBeenCalledWith('/home/user', { profileId: 'p1' })
    expect(sessionState.createTabInDirectory).not.toHaveBeenCalled()
  })
})

describe('handleNewConversationShortcut — locked enterprise path', () => {
  it('creates a tab with the mandated dir+profile and does NOT dispatch the picker', async () => {
    const { handleNewConversationShortcut } = await import('../useKeyboardShortcuts')
    prefState.engineProfiles = [{ id: 'p1', name: 'Orion', extensions: ['ext/p1'] }]
    prefState.defaultEngineProfileId = ''
    prefState.enterpriseNewConversationDefaults = {
      locked: true,
      baseDirectory: '/corp/projects',
      engineProfileId: 'corp-profile',
    }

    const { dispatchFn, events } = makeDispatch()
    handleNewConversationShortcut('/home/user', 'Cmd+T', dispatchFn)

    const pickerEvent = events.find((e) => e.type === 'ion:open-new-conversation-picker')
    expect(pickerEvent).toBeUndefined()
    // Mandated dir overrides the caller-supplied dir
    expect(sessionState.createConversationTab).toHaveBeenCalledWith('/corp/projects', { profileId: 'corp-profile' })
    expect(sessionState.createTabInDirectory).not.toHaveBeenCalled()
  })
})
