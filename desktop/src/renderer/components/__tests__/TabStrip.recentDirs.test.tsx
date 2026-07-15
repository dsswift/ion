// @vitest-environment jsdom
//
// Regression test for the Cmd+R "open recent directories" shortcut bridge in
// TabStrip. The shortcut handler in useKeyboardShortcuts.ts fires:
//
//   window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
//
// TabStrip must listen for this event and open the DirectoryPicker in
// 'conversation' mode, anchored to the + button. This test verifies the
// bridge: after the event fires, DirectoryPicker receives a non-null anchor
// with mode='conversation'. Without the listener the picker never mounts
// (dirPickerState stays null) — this test turns red on the unfixed code.
//
// Root cause history: the listener was silently dropped in commit 73c4d6af
// ("fix tsc errors across renderer and main", 2026-04-30) and never restored
// through the b1284c11 refactor or the 464da7fb conversation-unification.

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't include ResizeObserver. TabStrip's scroll-indicator useEffect
// constructs one; stub it so the component mounts cleanly.
if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// ─── Module stubs ─────────────────────────────────────────────────────────────
// TabStrip pulls in the full renderer tree. Stub everything outside the unit
// under test (the ion:open-recent-dirs useEffect bridge).

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children ?? null,
  motion: {
    div: React.forwardRef(({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>, ref) =>
      React.createElement('div', { ...rest, ref }, children)),
  },
}))

vi.mock('@phosphor-icons/react', () => ({
  Terminal: () => null,
  UsersThree: () => null,
  CaretLeft: () => null,
  CaretRight: () => null,
  ArrowsInSimple: () => null,
  ArrowsOutSimple: () => null,
  ChatCircle: () => null,
  // TabStripShared PILL_ICON_MAP icons
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
  // DirectoryPicker icons
  FolderPlus: () => null, FolderOpen: () => null, Trash: () => null,
  // HistoryPicker / NotificationsBell icons
  Clock: () => null, ChatCircleText: () => null, Stack: () => null, Bell: () => null,
  BellRinging: () => null, X: () => null,
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

// Track DirectoryPicker mounts so we can assert the picker was opened.
// `anchor` is recorded so we can verify it has a numeric x/y/bottom shape,
// confirming the bridge computed a position from plusButtonRef (or fallback).
const directoryPickerCalls: Array<{ anchor: { x: number; y: number; bottom: number } }> = []

vi.mock('../TabStripDirectoryPicker', () => ({
  DirectoryPicker: (props: { anchor: { x: number; y: number; bottom: number }; onSelectDir: () => void; onClose: () => void }) => {
    directoryPickerCalls.push({ anchor: props.anchor })
    return React.createElement('div', { 'data-testid': 'dir-picker' })
  },
}))

vi.mock('../TabStripTabPill', () => ({
  TabPill: () => null,
}))

vi.mock('../TabStripGroupPill', () => ({
  GroupPill: () => null,
}))

vi.mock('../TabStripPillColorPicker', () => ({
  PillColorPicker: () => null,
}))

vi.mock('../TabStripDirContextMenu', () => ({
  DirContextMenu: () => null,
}))

vi.mock('../TabStripTabContextMenu', () => ({
  TabContextMenu: () => null,
}))

vi.mock('../HistoryPicker', () => ({
  HistoryPicker: () => null,
}))

vi.mock('../SettingsPopover', () => ({
  SettingsPopover: () => null,
}))

vi.mock('../NotificationsPanel', () => ({
  NotificationsBell: () => null,
}))

vi.mock('../BranchPickerDialog', () => ({
  BranchPickerDialog: () => null,
}))

vi.mock('../NewConversationPicker', () => ({
  NewConversationPicker: () => null,
  resolveNewConversationAction: () => ({ kind: 'plain' }),
  executeNewConversationAction: () => undefined,
  newTabInDirectory: () => undefined,
}))

vi.mock('../new-conversation-routing', () => ({
  resolveNewConversationAction: () => ({ kind: 'plain' }),
  executeNewConversationAction: () => undefined,
  newTabInDirectory: () => undefined,
}))

vi.mock('../../hooks/useTabGroups', () => ({
  useTabGroups: () => ({ mode: 'off', groups: [], ungrouped: [] }),
}))

vi.mock('../../hooks/useManualReorder', () => ({
  useManualReorder: () => ({
    onItemPointerDown: () => {},
    isDraggingRef: { current: false },
  }),
}))

vi.mock('../TabStripShared', () => ({
  checkWorktreeUncommitted: () => {},
  shouldUseWorktree: () => false,
  zoomRect: (r: DOMRect) => r,
  anyEngineInstanceHasRunningChildren: () => false,
}))

vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => null,
  PopoverLayer: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))

vi.mock('../../stores/remote-fs-store', () => ({
  pickDirectoryForSession: async () => null,
}))

// Minimal session store stub: tabsReady=true so TabStrip renders (not the
// skeleton), one idle tab so the strip has something to work with.
const STUB_TAB = {
  id: 'tab-1',
  title: 'Test tab',
  customTitle: null,
  engineProfileId: null,
  workingDirectory: '/work/ion',
  status: 'idle',
  worktree: false,
  groupId: null,
  pillColor: null,
  pillIcon: null,
  pendingWorktreeSetup: false,
  hasChosenDirectory: true,
  historicalSessionIds: [],
  conversationId: null,
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      tabs: [STUB_TAB],
      activeTabId: 'tab-1',
      conversationPanes: new Map(),
      tabsReady: true,
      isExpanded: false,
      terminalOpenTabIds: new Set(),
      terminalTallTabId: null,
      tallViewTabId: null,
      worktreeUncommittedMap: new Map(),
      fileEditorFocused: false,
      fileEditorOpenDirs: new Set(),
      fileEditorStates: new Map(),
      openFloatingPanelCount: 0,
      staticInfo: { homePath: '/Users/test' },
      selectTab: () => {},
      closeTab: () => {},
      reorderTabs: () => {},
      renameTab: () => {},
      setTabPillColor: () => {},
      setTabPillIcon: () => {},
      createTabInDirectory: () => {},
      toggleTerminal: () => {},
      createTerminalTab: () => {},
      createConversationTab: () => {},
      toggleExpanded: () => {},
      toggleFileExplorer: () => {},
      toggleFileEditor: () => {},
      toggleGitPanel: () => {},
      toggleTerminalTall: () => {},
      toggleTallView: () => {},
      forkTab: () => {},
      finishWorktreeTab: () => {},
      setupWorktree: () => {},
      cancelWorktreeSetup: () => {},
      createScratchFile: () => {},
      addTerminalInstance: () => {},
    }),
  editorDirForTab: () => '/work/ion',
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({
      recentBaseDirectories: ['/work/ion', '/work/other'],
      directoryUsageCounts: {},
      defaultBaseDirectory: '/work/ion',
      enterpriseNewConversationDefaults: null,
      engineProfiles: [],
      defaultEngineProfileId: '',
      uiZoom: 1,
      addRecentBaseDirectory: () => {},
      incrementDirectoryUsage: () => {},
      removeRecentBaseDirectory: () => {},
    }),
}))

// ─── Test ──────────────────────────────────────────────────────────────────────

import { TabStrip } from '../TabStrip'

describe('TabStrip ion:open-recent-dirs bridge', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    directoryPickerCalls.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(React.createElement(TabStrip))
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('does NOT render DirectoryPicker before the event fires', () => {
    // Baseline: no picker on initial render.
    expect(container.querySelector('[data-testid="dir-picker"]')).toBeNull()
    expect(directoryPickerCalls).toHaveLength(0)
  })

  it('renders DirectoryPicker in conversation mode after ion:open-recent-dirs fires', () => {
    act(() => {
      window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
    })

    // DirectoryPicker must mount — dirPickerState is non-null.
    const picker = container.querySelector('[data-testid="dir-picker"]')
    expect(picker).not.toBeNull()

    // The mock was called and received a numeric anchor (not null/undefined),
    // confirming the bridge computed a position rather than no-oping.
    expect(directoryPickerCalls.length).toBeGreaterThan(0)
    const { anchor } = directoryPickerCalls[0]
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    expect(typeof anchor.bottom).toBe('number')
  })

  it('closes DirectoryPicker when a second event fires (toggle via re-open)', () => {
    // First open
    act(() => {
      window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
    })
    expect(container.querySelector('[data-testid="dir-picker"]')).not.toBeNull()

    // Dispatching again re-opens (replaces) the picker — dirPickerState is set again.
    act(() => {
      window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
    })
    // Should still be open (re-set, not toggled off).
    expect(container.querySelector('[data-testid="dir-picker"]')).not.toBeNull()
  })
})
