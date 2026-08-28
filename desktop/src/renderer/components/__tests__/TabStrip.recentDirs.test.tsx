// @vitest-environment jsdom
//
// Regression test for the Cmd+R bridge. Directory search now lives inside the
// unified new-conversation picker, so the former recent-directory command must
// open that picker instead of the legacy anchored DirectoryPicker.

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

const unifiedPickerCalls: unknown[] = []

vi.mock('../TabStripDirectoryPicker', () => ({ DirectoryPicker: () => null }))

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


vi.mock('../NotificationsPanel', () => ({
  NotificationsBell: () => null,
}))

vi.mock('../BranchPickerDialog', () => ({
  BranchPickerDialog: () => null,
}))

vi.mock('../NewConversationPicker', () => ({
  NewConversationPicker: (props: unknown) => {
    unifiedPickerCalls.push(props)
    return React.createElement('div', { 'data-testid': 'new-conversation-picker' })
  },
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
  anyEngineInstanceHasRunningChildren: () => false,
  anyEngineInstanceHasRunningShells: () => false,
}))

// The zoom helpers moved out of TabStripShared into renderer/viewport-zoom so
// every popover can reach them without importing a tab-strip module. The mock
// must cover the module's whole surface: a partial factory makes any newly
// consumed helper an "export is not defined" failure at import time.
vi.mock('../../viewport-zoom', () => ({
  zoomPoint: (p: { x: number; y: number }) => p,
  zoomDelta: (d: { x: number; y: number }) => d,
  zoomRect: (r: DOMRect) => r,
  zoomViewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
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
      requestCloseTab: async () => {},
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
      removeRecentBaseDirectory: () => {},
    }),
}))

// ─── Test ──────────────────────────────────────────────────────────────────────

import { NewConversationPickerHost } from '../NewConversationPickerHost'

describe('NewConversationPickerHost event bridge', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    unifiedPickerCalls.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(React.createElement(NewConversationPickerHost))
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('does NOT render the unified picker before the event fires', () => {
    expect(container.querySelector('[data-testid="new-conversation-picker"]')).toBeNull()
    expect(unifiedPickerCalls).toHaveLength(0)
  })

  it('opens the unified picker after ion:open-recent-dirs fires', () => {
    act(() => { window.dispatchEvent(new CustomEvent('ion:open-recent-dirs')) })
    expect(container.querySelector('[data-testid="new-conversation-picker"]')).not.toBeNull()
    expect(unifiedPickerCalls.length).toBeGreaterThan(0)
  })

  it('passes a known worktree target to the conversation-type picker', () => {
    const worktree = {
      repoPath: '/work/ion',
      worktreePath: '/worktrees/feature',
      branchName: 'wt/feature',
      sourceBranch: 'main',
    }
    act(() => {
      window.dispatchEvent(new CustomEvent('ion:open-new-conversation-picker', {
        detail: { initialDirectory: worktree.worktreePath, initialWorktree: worktree },
      }))
    })

    expect(unifiedPickerCalls.at(-1)).toEqual(expect.objectContaining({
      initialDirectory: worktree.worktreePath,
      initialWorktree: worktree,
    }))
  })

  it('keeps the unified picker open when the command fires again', () => {
    act(() => { window.dispatchEvent(new CustomEvent('ion:open-recent-dirs')) })
    act(() => { window.dispatchEvent(new CustomEvent('ion:open-recent-dirs')) })
    expect(container.querySelector('[data-testid="new-conversation-picker"]')).not.toBeNull()
  })
})
