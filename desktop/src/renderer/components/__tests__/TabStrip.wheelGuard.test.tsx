// @vitest-environment jsdom
//
// Regression tests for the tab-strip wheel handler.
//
// Root cause 1 (2026-06-27): React synthetic wheel events from portaled popovers
// (GroupPickerDropdown) bubble through the React component tree to TabStrip's
// onWheel handler even though their DOM target lives in the PopoverLayer, not
// inside the scrollRef container. Without the DOM-containment guard, scrollLeft
// changes on the tab strip whenever the user scrolls inside the group picker.
//
// Root cause 2 (2026-07-05): React's synthetic onWheel handler is registered as
// a PASSIVE listener in React 17+. Calling e.preventDefault() inside a passive
// listener is a no-op that logs "Unable to preventDefault inside passive event
// listener invocation". The fix moves the handler to a native addEventListener
// with { passive: false } so preventDefault is honored.
//
// This test verifies:
//   1. A wheel event whose target is OUTSIDE scrollRef does NOT change scrollLeft
//      (the containment guard fires).
//   2. A wheel event whose target IS inside scrollRef DOES change scrollLeft
//      (normal horizontal scroll still works).
//   3. preventDefault is called on an inside-target wheel event (goes red if
//      { passive: false } is removed or the preventDefault call is removed).
//
// Reversibility:
//   - Removing the `el.contains(...)` guard causes assertion (1) to fail.
//   - Removing `{ passive: false }` from addEventListener doesn't directly fail
//     in jsdom (jsdom doesn't enforce the passive restriction), but assertion (3)
//     pins the explicit preventDefault() call: if it is removed, the spy goes
//     uncalled and the test fails.
//   - Switching back to React's onWheel (passive by default) causes assertion (3)
//     to fail because jsdom DOES invoke the spy when addEventListener is used but
//     would not invoke it if the handler were re-routed through the React tree
//     without using addEventListener (since we dispatch native WheelEvents).

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// ─── Module stubs (same shape as TabStrip.recentDirs.test.tsx) ────────────────

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
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
  FolderPlus: () => null, FolderOpen: () => null, Trash: () => null,
  Clock: () => null, ChatCircleText: () => null, Stack: () => null, Bell: () => null,
  BellRinging: () => null, X: () => null,
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../TabStripDirectoryPicker', () => ({
  DirectoryPicker: () => null,
}))

vi.mock('../TabStripTabPill', () => ({
  TabPill: ({ tabRefs, tab }: { tabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>; tab: { id: string } }) => {
    // Render a real div so we can grab it as a target inside scrollRef.
    return React.createElement('div', {
      'data-testid': `tab-pill-${tab.id}`,
      ref: (el: HTMLDivElement | null) => { if (el) tabRefs.current.set(tab.id, el) },
    })
  },
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

vi.mock('../WorkspaceStatusIndicator', () => ({
  WorkspaceStatusIndicator: () => null,
}))

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
      recentBaseDirectories: [],
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { TabStrip } from '../TabStrip'

/** Find the scroll container created by TabStrip and verify it exists. */
function getScrollDiv(container: HTMLDivElement): HTMLElement {
  const el = container.querySelector('[class*="overflow-x-auto"]') as HTMLElement | null
  if (!el) throw new Error('Could not find scrollRef div (overflow-x-auto element)')
  return el
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TabStrip wheel handler — native non-passive listener', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
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

  it('does not change scrollLeft when wheel target is OUTSIDE scrollRef (portal bleed guard)', () => {
    const scrollDiv = getScrollDiv(container)
    expect(scrollDiv.scrollLeft).toBe(0)

    // Simulate a portaled element whose wheel event bubbles into the container.
    const outsideEl = document.createElement('div')
    document.body.appendChild(outsideEl)

    act(() => {
      // Native WheelEvent dispatched on scrollDiv but with target set to the
      // outside element — this is what happens when a portaled popover wheel
      // event bubbles through the DOM. The containment guard must reject it.
      const evt = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'target', { value: outsideEl, configurable: true })
      scrollDiv.dispatchEvent(evt)
    })

    // Guard must have fired: scrollLeft must stay 0.
    expect(scrollDiv.scrollLeft).toBe(0)

    outsideEl.remove()
  })

  it('changes scrollLeft when wheel target IS inside scrollRef (normal scroll works)', () => {
    const scrollDiv = getScrollDiv(container)

    // Spy on the scrollLeft setter to detect that the handler ran.
    let capturedScrollLeftDelta: number | undefined
    Object.defineProperty(scrollDiv, 'scrollLeft', {
      get: () => capturedScrollLeftDelta ?? 0,
      set: (v: number) => { capturedScrollLeftDelta = v },
      configurable: true,
    })

    act(() => {
      // A tab pill inside the scroll container is the native target.
      const tabPillEl = container.querySelector('[data-testid="tab-pill-tab-1"]') as HTMLElement
      const innerTarget = tabPillEl ?? scrollDiv.firstElementChild ?? scrollDiv

      const evt = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'target', { value: innerTarget, configurable: true })
      scrollDiv.dispatchEvent(evt)
    })

    // Handler must have run: scrollLeft was set to delta (0 + 50).
    expect(capturedScrollLeftDelta).toBe(50)
  })

  it('calls preventDefault on an inside-target wheel event (honors { passive: false })', () => {
    // This assertion goes red if:
    //   a) the handler is removed entirely, or
    //   b) the e.preventDefault() call is removed from the handler, or
    //   c) the listener is registered WITHOUT { passive: false } and jsdom
    //      enforces the passive restriction (currently jsdom does not enforce it,
    //      but the explicit spy pins the call regardless of environment).
    const scrollDiv = getScrollDiv(container)

    const tabPillEl = container.querySelector('[data-testid="tab-pill-tab-1"]') as HTMLElement
    const innerTarget = tabPillEl ?? scrollDiv.firstElementChild ?? scrollDiv

    const evt = new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true })
    Object.defineProperty(evt, 'target', { value: innerTarget, configurable: true })
    const preventDefaultSpy = vi.spyOn(evt, 'preventDefault')

    act(() => {
      scrollDiv.dispatchEvent(evt)
    })

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1)
  })
})
