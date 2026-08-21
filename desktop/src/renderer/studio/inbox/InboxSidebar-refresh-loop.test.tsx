// @vitest-environment jsdom
/**
 * InboxSidebar — the workspace-refresh effect must converge.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * The sidebar refreshes the workspace views for every project it displays. That
 * refresh writes the store the sidebar subscribes to (`worktreeInventory`,
 * `benchWorkspaces`), so the effect that triggers it is one un-memoized input
 * away from being its own trigger: refresh → store notify → re-render → effect
 * fires again → refresh. Shipped that way, it ran at ~800 passes/sec with the
 * renderer pinned at 107% CPU and 4.2 GB RSS.
 *
 * The store slices now write only on change, which breaks the cycle from the
 * store side. This test pins the OTHER side independently: the fake store here
 * deliberately notifies on EVERY refresh (the pre-fix store behaviour), and the
 * component must still settle. A component that only converges because the
 * store happens to be quiescent is one un-memoized dep away from the loop
 * returning, and nothing would catch it.
 *
 * Children are stubbed because none of them participate in the effect; the
 * partition hook, the grouping, and the navigator are all real, because the
 * identities they produce are exactly what the effect's dep is derived from.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { create } from 'zustand'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPO = '/Users/test/project'
const WT = '/Users/test/.ion/worktrees/project-a3f1'

const refreshWorkspaceViews = vi.fn()

interface FakeState {
  tabs: TabState[]
  activeTabId: string | null
  conversationPanes: Map<string, unknown>
  benchWorkspaces: Map<string, unknown[]>
  worktreeInventory: Map<string, unknown[]>
  settledHistory: TabState[]
  refreshWorkspaceViews: (repoPath: string) => void
  createTabInDirectory: () => Promise<string>
  createConversationTab: () => Promise<string>
  openSettings: () => void
}

function tab(over: Partial<TabState> & { id: string }): TabState {
  return {
    title: 'Conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory: REPO,
    ...over,
  } as TabState
}

const useFakeStore = create<FakeState>((set) => ({
  tabs: [
    tab({ id: 'tab-1' }),
    tab({
      id: 'tab-2',
      workingDirectory: WT,
      worktree: { repoPath: REPO, worktreePath: WT, branchName: 'wt/a3f1', sourceBranch: 'main' },
    } as Partial<TabState> & { id: string }),
  ],
  activeTabId: 'tab-1',
  conversationPanes: new Map(),
  benchWorkspaces: new Map(),
  worktreeInventory: new Map(),
  settledHistory: [],
  // Writes UNCONDITIONALLY, reproducing the store behaviour that made the loop
  // self-sustaining. The component is what has to converge here.
  refreshWorkspaceViews: (repoPath: string) => {
    refreshWorkspaceViews(repoPath)
    set((s) => ({
      worktreeInventory: new Map(s.worktreeInventory).set(repoPath, []),
      benchWorkspaces: new Map(s.benchWorkspaces).set(repoPath, []),
    }))
  },
  createTabInDirectory: async () => 'tab-new',
  createConversationTab: async () => 'tab-new',
  openSettings: () => {},
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: FakeState) => unknown) => useFakeStore(selector as never),
    { getState: () => useFakeStore.getState() },
  ),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: { inboxAutoSettleDays: number }) => unknown) => selector({ inboxAutoSettleDays: 0 }),
    { getState: () => ({ inboxAutoSettleDays: 0 }) },
  ),
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

// Inline rather than a shared `stub()` helper: vi.mock factories are hoisted
// above every top-level binding, so a helper defined here is not yet
// initialized when they run.
vi.mock('./InboxRow', () => ({ InboxRow: () => React.createElement('div') }))
vi.mock('./InboxNavigatorGroups', () => ({ InboxNavigatorGroups: () => React.createElement('div') }))
vi.mock('./SettledHistoryView', () => ({ SettledHistoryView: () => React.createElement('div') }))
vi.mock('../../components/NewConversationPicker', () => ({ NewConversationPicker: () => React.createElement('div') }))
vi.mock('../../components/TabStripShared', () => ({
  shouldUseWorktree: () => false,
  waitingStateOfPane: () => null,
}))
vi.mock('./InboxControls', () => ({
  InboxControlButton: () => React.createElement('div'),
  InboxProjectScopePicker: () => React.createElement('div'),
  InboxSortPicker: () => React.createElement('div'),
}))

import { InboxSidebar } from './InboxSidebar'

let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

describe('InboxSidebar workspace refresh', () => {
  it('refreshes each displayed project once and then settles', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(InboxSidebar)) })
    // Let any effect-triggered re-render cascade run to completion.
    await act(async () => { await Promise.resolve() })

    // Both fixtures resolve to the same project (the worktree tab reports its
    // repoPath), so a converged component refreshes exactly one project once.
    expect(refreshWorkspaceViews.mock.calls.map((call) => call[0])).toEqual([REPO])

    await act(async () => { root.unmount() })
  })

  it('does not re-fire when the store notifies with an unchanged project set', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(InboxSidebar)) })
    await act(async () => { await Promise.resolve() })
    const afterMount = refreshWorkspaceViews.mock.calls.length

    // A store write that changes nothing about WHICH projects are displayed —
    // exactly what the refresh itself produces, and what a status tick produces.
    await act(async () => {
      useFakeStore.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t })) }))
      await Promise.resolve()
    })

    expect(refreshWorkspaceViews.mock.calls.length).toBe(afterMount)

    await act(async () => { root.unmount() })
  })

  it('does not refresh workspaces when only active tab changes', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(InboxSidebar)) })
    await act(async () => { await Promise.resolve() })
    const afterMount = refreshWorkspaceViews.mock.calls.length

    await act(async () => {
      useFakeStore.setState({ activeTabId: 'tab-2' })
      await Promise.resolve()
    })

    expect(refreshWorkspaceViews.mock.calls.length).toBe(afterMount)
    await act(async () => { root.unmount() })
  })

  it('refreshes again when a conversation in a new project appears', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(InboxSidebar)) })
    await act(async () => { await Promise.resolve() })
    refreshWorkspaceViews.mockClear()

    await act(async () => {
      useFakeStore.setState((s) => ({
        tabs: [...s.tabs, tab({ id: 'tab-3', workingDirectory: '/Users/test/other' })],
      }))
      await Promise.resolve()
    })

    // Convergence must not be achieved by never refreshing again.
    expect(refreshWorkspaceViews.mock.calls.map((call) => call[0])).toContain('/Users/test/other')

    await act(async () => { root.unmount() })
  })
})
