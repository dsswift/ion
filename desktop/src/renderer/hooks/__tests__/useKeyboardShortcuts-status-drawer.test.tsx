// @vitest-environment jsdom
/**
 * useKeyboardShortcuts — Cmd+4 toggles the Status Drawer.
 *
 * This mounts the REAL hook and dispatches real keydown events, so the assertion
 * covers the handler branch itself rather than just the catalog entry. The
 * sibling catalog-driven test proves resolveBindings maps the chord; this proves
 * something is listening for it.
 *
 * Contract:
 *   (a) Cmd+4 calls toggleStatusDrawer exactly once, and does not touch the git
 *       panel -- the store owns the mutual close, the handler just toggles.
 *   (b) Cmd+3 still calls toggleGitPanel, so the new branch did not shadow the
 *       adjacent one.
 *   (c) An override moves the drawer to its new chord and the old Cmd+4 goes
 *       dead, which is the difference between a catalog-driven handler and a
 *       hardcoded `e.key === '4'`.
 *
 * Revert check: without the handler branch, (a) and (c)'s first half fail while
 * (b) still passes. Without the catalog entry, every drawer assertion fails.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mod resolves to metaKey only on mac, and `chord.ts` reads IS_MAC ONCE at module
// scope. Static imports are evaluated before any beforeAll/beforeEach runs, so
// the platform has to be forced during the hoisted phase -- setting it in a hook
// would leave the already-imported chord module resolving Mod to Ctrl, and every
// metaKey event below would silently fail to match.
vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
})

// ── Store mocks ────────────────────────────────────────────────────────────

const toggleStatusDrawer = vi.fn()
const toggleGitPanel = vi.fn()

let prefState = {
  editorFontSize: 14,
  conversationFontSize: 13,
  previewFontSize: 13,
  keyboardShortcuts: {} as Record<string, string>,
  setEditorFontSize: vi.fn(),
  setConversationFontSize: vi.fn(),
  setPreviewFontSize: vi.fn(),
  defaultBaseDirectory: '',
  engineProfiles: [],
  defaultEngineProfileId: '',
  enterpriseNewConversationDefaults: null,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sessionState: any

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefState },
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => sessionState,
    setState: vi.fn(),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editorDirForTab: (tab: any) => tab?.workingDirectory ?? '',
}))

vi.mock('../../../shared/tab-predicates', () => ({
  tabHasExtensions: () => false,
}))

vi.mock('../../components/new-conversation-routing', () => ({
  resolveNewConversationAction: () => ({ kind: 'plain' }),
  executeNewConversationAction: vi.fn(),
}))

vi.mock('../../stores/conversation-instance', () => ({
  effectivePermissionMode: () => 'plan',
}))

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(),
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
}))

import { useKeyboardShortcuts } from '../useKeyboardShortcuts'

// ── Harness ────────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any = null

function Probe(): null {
  useKeyboardShortcuts()
  return null
}

function mountProbe(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Probe />)
  })
}

function pressKey(key: string, opts: { metaKey?: boolean; shiftKey?: boolean } = {}): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      metaKey: opts.metaKey ?? false,
      ctrlKey: false,
      shiftKey: opts.shiftKey ?? false,
      altKey: false,
      bubbles: true,
      cancelable: true,
    }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  prefState = {
    editorFontSize: 14,
    conversationFontSize: 13,
    previewFontSize: 13,
    keyboardShortcuts: {},
    setEditorFontSize: vi.fn(),
    setConversationFontSize: vi.fn(),
    setPreviewFontSize: vi.fn(),
    defaultBaseDirectory: '',
    engineProfiles: [],
    defaultEngineProfileId: '',
    enterpriseNewConversationDefaults: null,
  }
  sessionState = {
    tabs: [{ id: 'tab1', workingDirectory: '/projects/ion', title: 'Test', customTitle: null }],
    activeTabId: 'tab1',
    fileEditorFocused: false,
    fileEditorOpenDirs: new Set<string>(),
    fileEditorStates: new Map(),
    openFloatingPanelCount: 0,
    isExpanded: false,
    settingsOpen: false,
    terminalOpenTabIds: new Set<string>(),
    terminalTallTabId: null,
    tallViewTabId: null,
    conversationPanes: new Map(),
    selectTab: vi.fn(),
    toggleFileExplorer: vi.fn(),
    toggleFileEditor: vi.fn(),
    toggleTerminal: vi.fn(),
    addTerminalInstance: vi.fn(),
    toggleGitPanel,
    toggleStatusDrawer,
    setPermissionMode: vi.fn(),
    toggleExpanded: vi.fn(),
    createScratchFile: vi.fn(),
    toggleTallView: vi.fn(),
    toggleTerminalTall: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
  }
})

afterEach(() => {
  if (root) {
    act(() => {
      root.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Cmd+4 — the Status Drawer branch exists in the handler', () => {
  it('calls toggleStatusDrawer exactly once', () => {
    mountProbe()

    pressKey('4', { metaKey: true })

    expect(toggleStatusDrawer).toHaveBeenCalledTimes(1)
  })

  it('does not touch the git panel: exclusivity is the store\'s job', () => {
    // The handler stays a plain toggle. If it also called toggleGitPanel the
    // invariant would be duplicated in two places and would drift.
    mountProbe()

    pressKey('4', { metaKey: true })

    expect(toggleGitPanel).not.toHaveBeenCalled()
  })

  it('leaves Cmd+3 wired to the git panel', () => {
    // The new branch is adjacent to panel.git in the handler; this catches a
    // copy-paste that pointed both at the same action.
    mountProbe()

    pressKey('3', { metaKey: true })

    expect(toggleGitPanel).toHaveBeenCalledTimes(1)
    expect(toggleStatusDrawer).not.toHaveBeenCalled()
  })

  it('ignores a bare 4 with no modifier', () => {
    mountProbe()

    pressKey('4')

    expect(toggleStatusDrawer).not.toHaveBeenCalled()
  })
})

describe('Cmd+4 is a binding, not a hardcoded key', () => {
  it('an override moves the drawer to the new chord', () => {
    prefState.keyboardShortcuts = { 'panel.statusDrawer': 'Mod+9' }
    mountProbe()

    pressKey('9', { metaKey: true })

    expect(toggleStatusDrawer).toHaveBeenCalledTimes(1)
  })

  it('the old Cmd+4 goes dead once overridden', () => {
    // This is the assertion a hardcoded `e.key === '4'` check would fail.
    prefState.keyboardShortcuts = { 'panel.statusDrawer': 'Mod+9' }
    mountProbe()

    pressKey('4', { metaKey: true })

    expect(toggleStatusDrawer).not.toHaveBeenCalled()
  })
})
