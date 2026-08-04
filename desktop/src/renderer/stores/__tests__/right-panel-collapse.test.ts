/**
 * right-panel-collapse — the collapse rule treats both right-side panels alike.
 *
 * `setupPersistence` subscribes to expanded -> collapsed and closes the panels
 * the operator has not asked to keep. The git panel had an arm from the start;
 * the Status Drawer did not, which was coherent only while the drawer was a
 * bystander. It is now the git panel's peer -- same right edge, same numbered
 * shortcut row, and the store permits only one of the two open -- so
 * "Cmd+4 then Cmd+J" left a drawer pinned over a collapsed card where
 * "Cmd+3 then Cmd+J" would not have.
 *
 * Contract:
 *   (a) Drawer open, preference off -> collapse closes it AND clears the
 *       dispatch deep-link (matching closeStatusDrawer, so a stale selection
 *       cannot survive to the next open).
 *   (b) Drawer open, preference ON -> the drawer survives the collapse, and its
 *       deep-link survives with it.
 *   (c) The two panels are independent: each obeys its OWN preference, so the
 *       new arm introduces no coupling.
 *   (d) Collapse is the trigger, not any setState: expanding, or a change while
 *       already collapsed, closes nothing.
 *
 * Revert check: (a) and the drawer half of (c) fail against a subscriber with no
 * drawer branch -- statusDrawerOpen simply stays true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mutable preference stub ──────────────────────────────────────────────────
//
// Hoisted so the vi.mock factory closes over the same object these tests
// mutate; the subscriber reads it through getState() on every transition, so a
// per-test assignment is enough.

const prefs = vi.hoisted(() => ({
  current: {
    tabRecoveryEnabled: false,
    tabRecoveryTimeoutSec: 60,
    expandOnTabSwitch: true,
    keepTerminalOnCollapse: false,
    keepExplorerOnCollapse: false,
    keepGitPanelOnCollapse: false,
    keepStatusDrawerOnCollapse: false,
  } as Record<string, unknown>,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefs.current },
}))

vi.mock('../../components/TerminalInstance', () => ({
  serializeTerminalBuffer: () => null,
}))

vi.mock('../../../shared/tab-predicates', () => ({
  tabHasExtensions: () => false,
}))

vi.mock('../serialize-conversation-pane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serialize-conversation-pane')>()
  return { ...actual, serializeConversationPane: () => null }
})

vi.mock('../../../shared/types-persistence', () => ({
  EXTERNALIZE_SCHEMA_VERSION: 4,
}))

import { setupPersistence } from '../session-store-persistence'

// ─── Store stub ───────────────────────────────────────────────────────────────

// `any` on the stub, matching session-store-persistence-rehydration.test.ts:
// setupPersistence takes the real UseBoundStore<StoreApi<State>>, which is
// callable as a selector hook. Satisfying that signature structurally would mean
// standing up a whole Zustand store for three fields the subscriber reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (state: any, prev: any) => void

function makeStoreStub(initial: Record<string, unknown> = {}) {
  const listeners: Listener[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentState: any = {
    tabs: [],
    activeTabId: 'tab1',
    isExpanded: true,
    gitPanelOpen: false,
    statusDrawerOpen: false,
    statusDrawerDispatchId: null,
    fileEditorStates: new Map(),
    fileEditorOpenDirs: new Set<string>(),
    editorGeometry: { x: 0, y: 0, w: 0, h: 0 },
    planGeometry: { x: 0, y: 0, w: 0, h: 0 },
    agentDetailGeometry: { x: 0, y: 0, w: 0, h: 0 },
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set<string>(),
    conversationPanes: new Map(),
    rehydrating: false,
    tabsReady: false,
    forceRecoverTab: vi.fn(),
    ...initial,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = {
    subscribe: (fn: Listener) => {
      listeners.push(fn)
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
    },
    getState: () => currentState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setState: (patch: any) => {
      const prev = { ...currentState }
      const next = typeof patch === 'function' ? patch(currentState) : patch
      currentState = { ...currentState, ...next }
      listeners.forEach((fn) => fn(currentState, prev))
    },
  }
  return store
}

beforeEach(() => {
  prefs.current = {
    tabRecoveryEnabled: false,
    tabRecoveryTimeoutSec: 60,
    expandOnTabSwitch: true,
    keepTerminalOnCollapse: false,
    keepExplorerOnCollapse: false,
    keepGitPanelOnCollapse: false,
    keepStatusDrawerOnCollapse: false,
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    addEventListener: vi.fn(),
    ion: {
      saveTabs: vi.fn().mockResolvedValue(undefined),
      loadSessionChains: vi.fn(() => Promise.resolve({ chains: {}, reverse: {} })),
      saveSessionChains: vi.fn(() => Promise.resolve()),
    },
  }
})

/** Drive the expanded -> collapsed transition the subscriber watches for. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collapse(store: any): void {
  store.setState({ isExpanded: false })
}

// ─── (a) drawer closes with the preference off ────────────────────────────────

describe('collapsing closes the Status Drawer by default', () => {
  it('closes the drawer and clears its dispatch deep-link', () => {
    const store = makeStoreStub({
      statusDrawerOpen: true,
      statusDrawerDispatchId: 'dispatch-1',
    })
    setupPersistence(store)

    collapse(store)

    expect(store.getState().statusDrawerOpen).toBe(false)
    // Cleared, not carried: closeStatusDrawer clears this too, and a drawer
    // reopened later must not silently re-select a dispatch the operator
    // navigated away from.
    expect(store.getState().statusDrawerDispatchId).toBe(null)
  })
})

// ─── (b) the preference is honoured ───────────────────────────────────────────

describe('keepStatusDrawerOnCollapse keeps the drawer open', () => {
  it('leaves the drawer and its deep-link intact', () => {
    prefs.current.keepStatusDrawerOnCollapse = true
    const store = makeStoreStub({
      statusDrawerOpen: true,
      statusDrawerDispatchId: 'dispatch-1',
    })
    setupPersistence(store)

    collapse(store)

    expect(store.getState().statusDrawerOpen).toBe(true)
    expect(store.getState().statusDrawerDispatchId).toBe('dispatch-1')
  })
})

// ─── (c) the two panels are independent ───────────────────────────────────────

describe('each right-side panel obeys its own preference', () => {
  it('keeps the git panel and closes the drawer', () => {
    prefs.current.keepGitPanelOnCollapse = true
    prefs.current.keepStatusDrawerOnCollapse = false
    // Both flags set at once is not reachable through the store's exclusivity
    // invariant, but the subscriber must not assume that -- it reads whatever
    // state it is handed.
    const store = makeStoreStub({ gitPanelOpen: true, statusDrawerOpen: true })
    setupPersistence(store)

    collapse(store)

    expect(store.getState().gitPanelOpen).toBe(true)
    expect(store.getState().statusDrawerOpen).toBe(false)
  })

  it('keeps the drawer and closes the git panel', () => {
    prefs.current.keepGitPanelOnCollapse = false
    prefs.current.keepStatusDrawerOnCollapse = true
    const store = makeStoreStub({ gitPanelOpen: true, statusDrawerOpen: true })
    setupPersistence(store)

    collapse(store)

    expect(store.getState().gitPanelOpen).toBe(false)
    expect(store.getState().statusDrawerOpen).toBe(true)
  })
})

// ─── (d) only the collapse edge fires ─────────────────────────────────────────

describe('the collapse edge is the trigger', () => {
  it('expanding does not close the drawer', () => {
    const store = makeStoreStub({ isExpanded: false, statusDrawerOpen: true })
    setupPersistence(store)

    store.setState({ isExpanded: true })

    expect(store.getState().statusDrawerOpen).toBe(true)
  })

  it('an unrelated change while already collapsed does not close the drawer', () => {
    // The operator opened the drawer on a collapsed card. Nothing about a
    // later setState should dismiss it.
    const store = makeStoreStub({ isExpanded: false, statusDrawerOpen: true })
    setupPersistence(store)

    store.setState({ activeTabId: 'tab2' })

    expect(store.getState().statusDrawerOpen).toBe(true)
  })
})
