// @vitest-environment jsdom
/**
 * InboxSidebar — a conversation on two machines at once is two rows.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * A transfer copies a conversation to the destination before it deletes the
 * source, so for a moment the union of every machine's tabs holds the same
 * conversation ID twice. Rows keyed by ID alone collided, and React, unable to
 * tell the two apart, stranded the source copy's row on screen after its
 * record was gone: a ghost row, and with it the Transfer dialog that row had
 * opened, whose backdrop then swallowed every click in the window. A row's key
 * must name the machine its conversation lives on.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { create } from 'zustand'
import type { TabState } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPO = '/Users/test/project'
const OSCAR = 'env-oscar'

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

const useFakeStore = create<FakeState>(() => ({
  tabs: [],
  activeTabId: 'tab-1',
  conversationPanes: new Map(),
  benchWorkspaces: new Map(),
  worktreeInventory: new Map(),
  settledHistory: [],
  refreshWorkspaceViews,
  createTabInDirectory: async () => 'tab-new',
  createConversationTab: async () => 'tab-new',
  openSettings: () => {},
}))

vi.mock('@ion/server/store/sessionStore', () => ({
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
// The row stub carries its conversation's machine, so the test can see which
// copy each rendered row stands for.
vi.mock('./InboxRow', () => ({
  InboxRow: ({ tab }: { tab: TabState }) => React.createElement('div', {
    'data-inbox-tab-id': tab.id,
    'data-environment-id': tab.environmentId ?? 'local',
  }),
}))
// Every row into ONE children array, through the sidebar's own `row()`, so the
// keys under test are exactly the keys the sidebar produces.
vi.mock('./InboxNavigatorGroups', () => ({
  InboxNavigatorGroups: ({ projects, variant, row }: {
    projects: Array<{ project: { name: string }; flatTabs: TabState[]; groups: Array<{ tabs: TabState[] }> }>
    variant: 'card' | 'slim'
    row: (tab: TabState, variant: 'card' | 'slim', projectName: string) => React.ReactNode
  }) => React.createElement('div', null, projects.flatMap((node) =>
    [...node.flatTabs, ...node.groups.flatMap((group) => group.tabs)].map((tab) => row(tab, variant, node.project.name)))),
}))
vi.mock('./SettledHistoryView', () => ({ SettledHistoryView: () => React.createElement('div') }))
vi.mock('../../components/NewConversationPicker', () => ({ NewConversationPicker: () => React.createElement('div') }))
vi.mock('../../components/conversation-status', () => ({
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

function renderedCopies(): string[] {
  return [...container.querySelectorAll('[data-inbox-tab-id="conv-1"]')].map((el) => el.getAttribute('data-environment-id') ?? '')
}

describe('InboxSidebar row identity across machines', () => {
  // Another conversation sorts between the two copies, so removing the source
  // shifts every row after it. That shift is what sent React down the
  // key-map path that lost track of the colliding row.
  const other = tab({ id: 'conv-other', lastActivityAt: 200 } as Partial<TabState> & { id: string })

  it.each([
    ['this machine to another', tab({ id: 'conv-1', lastActivityAt: 300 } as Partial<TabState> & { id: string }), tab({ id: 'conv-1', environmentId: OSCAR, lastActivityAt: 100 } as Partial<TabState> & { id: string })],
    ['another machine to this one', tab({ id: 'conv-1', environmentId: OSCAR, lastActivityAt: 300 } as Partial<TabState> & { id: string }), tab({ id: 'conv-1', lastActivityAt: 100 } as Partial<TabState> & { id: string })],
  ])('leaves exactly the destination row after a move from %s', async (_label, source, destination) => {
    useFakeStore.setState({ tabs: [source, other] })
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(InboxSidebar)) })
    expect(renderedCopies()).toEqual([source.environmentId ?? 'local'])

    // The destination has its copy; the source has not deleted its own yet.
    await act(async () => { useFakeStore.setState({ tabs: [source, other, destination] }) })
    expect(renderedCopies().sort()).toEqual([source.environmentId ?? 'local', destination.environmentId ?? 'local'].sort())

    // The source deletes its copy.
    await act(async () => { useFakeStore.setState({ tabs: [other, destination] }) })
    expect(renderedCopies()).toEqual([destination.environmentId ?? 'local'])

    await act(async () => { root.unmount() })
  })
})
