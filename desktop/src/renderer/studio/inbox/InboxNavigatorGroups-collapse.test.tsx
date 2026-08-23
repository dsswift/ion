// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationPane } from '../../../shared/types-engine'
import type { IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '../../../shared/types'
import type { InboxNavigatorProject } from './inbox-navigator'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  activeTabId: 'outside',
  tabs: [] as TabState[],
  conversationPanes: new Map<string, ConversationPane>(),
  worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
  workspaceOperationLedger: new Map(),
  benchWorkspaces: new Map<string, readonly IntegrationWorkspace[]>(),
  selectTab: vi.fn(), benchUpdateMember: vi.fn(async () => ({ ok: true })), benchUpdateAll: vi.fn(async () => ({ ok: true })),
  syncWorktree: vi.fn(async () => ({ ok: true })), benchAddMember: vi.fn(async () => undefined), benchRemoveMember: vi.fn(async () => undefined),
  cycleBenchConversation: vi.fn(), openBenchTerminal: vi.fn(async () => null), startWorktreePipeline: vi.fn(async () => undefined),
  openWorktreeConversation: vi.fn(async () => null), createConversationTab: vi.fn(async () => undefined), createTabInDirectory: vi.fn(async () => undefined), openSettings: vi.fn(),
}

vi.mock('../../stores/sessionStore', () => ({ useSessionStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn() }))
vi.mock('../../preferences', () => ({ usePreferencesStore: { getState: () => ({ engineProfiles: [], defaultEngineProfileId: null, enterpriseNewConversationDefaults: null }) } }))
vi.mock('../../components/WorktreePipelinePanel', () => ({ WorktreePipelinePanel: () => null }))
vi.mock('./InboxBenchBar', () => ({ InboxBenchBar: () => <div data-testid="bench-header" /> }))
vi.mock('./InboxBenchMenu', () => ({ InboxBenchMenu: () => null }))
vi.mock('./InboxBenchTerminalRow', () => ({ InboxBenchTerminalRow: ({ tabId }: { tabId: string }) => <div data-testid={`terminal-${tabId}`} /> }))
vi.mock('./InboxWorktreeRow', () => ({ InboxWorktreeRow: () => <div data-testid="worktree-header" /> }))
vi.mock('./InboxProjectMenu', () => ({ InboxProjectMenu: () => null }))
vi.mock('../../components/BranchPickerDialog', () => ({ BranchPickerDialog: () => null }))
vi.mock('../../components/NewConversationPicker', () => ({ NewConversationPicker: () => null }))

import { InboxNavigatorGroups } from './InboxNavigatorGroups'

function tab(id: string, status: TabState['status'] = 'idle'): TabState {
  return { id, title: id, customTitle: null, status, workingDirectory: '/repo', pinnedAt: null } as TabState
}

async function mount(project: InboxNavigatorProject, collapsedKey: string): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<InboxNavigatorGroups projects={[project]} collapsed={new Set([collapsedKey])} onToggle={() => {}} variant="card" selectedBench={{}} onSelectBench={() => {}} row={(item) => <div key={item.id} data-testid={`conversation-${item.id}`}>{item.title}</div>} />)
  })
  return { container, root }
}

function expectImportantRows(container: HTMLElement): void {
  expect(container.querySelector('[data-testid="conversation-selected"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="conversation-working"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="conversation-idle"]')).toBeNull()
}

afterEach(() => {
  document.body.replaceChildren()
  state.activeTabId = 'outside'
  state.tabs = []
  state.conversationPanes = new Map()
  state.worktreeInventory = new Map()
  state.benchWorkspaces = new Map()
})

describe('InboxNavigatorGroups collapsed important rows', () => {
  it('keeps selected and working conversations visible in a collapsed project', async () => {
    const selected = tab('selected')
    const working = tab('working', 'running')
    const idle = tab('idle')
    state.activeTabId = selected.id
    state.tabs = [selected, working, idle]
    const project: InboxNavigatorProject = { project: { key: '/repo', name: 'repo' }, groups: [{ key: 'source:/repo', kind: 'source', label: 'Source Repository', tabs: state.tabs }], flatTabs: [] }
    const { container, root } = await mount(project, 'project:/repo')
    expectImportantRows(container)
    await act(async () => { root.unmount() })
  })

  it('keeps selected and working conversations visible in a collapsed bench', async () => {
    const selected = tab('selected')
    const working = tab('working', 'running')
    const idle = tab('idle')
    const workspace: IntegrationWorkspace = { repoPath: '/repo', sourceBranch: 'main', benchPath: '/bench/main', benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 }
    state.activeTabId = selected.id
    state.tabs = [selected, working, idle]
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    const project: InboxNavigatorProject = { project: { key: '/repo', name: 'repo' }, groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: state.tabs, workspace }], flatTabs: [] }
    const { container, root } = await mount(project, `group:card:bench:${workspace.benchPath}`)
    expectImportantRows(container)
    await act(async () => { root.unmount() })
  })

  it.each([
    ['selected', null, 'bench-terminal'],
    ['pinned', 10, 'outside'],
  ])('keeps a %s bench terminal visible in a collapsed bench', async (_case, pinnedAt, activeTabId) => {
    const workspace: IntegrationWorkspace = { repoPath: '/repo', sourceBranch: 'main', benchPath: '/bench/main', benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 }
    const terminal = { ...tab('bench-terminal'), workingDirectory: workspace.benchPath, isTerminalOnly: true, pinnedAt } as TabState
    state.activeTabId = activeTabId
    state.tabs = [terminal]
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    const project: InboxNavigatorProject = { project: { key: '/repo', name: 'repo' }, groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: [], workspace }], flatTabs: [] }
    const { container, root } = await mount(project, `group:card:bench:${workspace.benchPath}`)
    expect(container.querySelector('[data-testid="terminal-bench-terminal"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it.each([
    ['selected', null, 'bench-terminal'],
    ['pinned', 10, 'outside'],
  ])('keeps a %s bench terminal visible when the whole project is collapsed', async (_case, pinnedAt, activeTabId) => {
    const workspace: IntegrationWorkspace = { repoPath: '/repo', sourceBranch: 'main', benchPath: '/bench/main', benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 }
    const terminal = { ...tab('bench-terminal'), workingDirectory: workspace.benchPath, isTerminalOnly: true, pinnedAt } as TabState
    state.activeTabId = activeTabId
    state.tabs = [terminal]
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    const project: InboxNavigatorProject = { project: { key: '/repo', name: 'repo' }, groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: [], workspace }], flatTabs: [] }
    const { container, root } = await mount(project, 'project:/repo')
    expect(container.querySelector('[data-testid="terminal-bench-terminal"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('hides an idle unselected unpinned bench terminal in a collapsed bench', async () => {
    const workspace: IntegrationWorkspace = { repoPath: '/repo', sourceBranch: 'main', benchPath: '/bench/main', benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 }
    const terminal = { ...tab('bench-terminal'), workingDirectory: workspace.benchPath, isTerminalOnly: true } as TabState
    state.tabs = [terminal]
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    const project: InboxNavigatorProject = { project: { key: '/repo', name: 'repo' }, groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: [], workspace }], flatTabs: [] }
    const { container, root } = await mount(project, `group:card:bench:${workspace.benchPath}`)
    expect(container.querySelector('[data-testid="terminal-bench-terminal"]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})
