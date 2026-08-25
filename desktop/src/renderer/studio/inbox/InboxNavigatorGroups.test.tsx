// @vitest-environment jsdom
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationPane } from '../../../shared/types-engine'
import type { TabState, WorktreeInventoryEntry, IntegrationWorkspace } from '../../../shared/types'
import type { InboxNavigatorProject } from './inbox-navigator'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const selectTab = vi.fn<(tabId: string) => void>()
const closeTab = vi.fn<(tabId: string) => void>()
const benchUpdateMember = vi.fn(async () => ({ ok: true }))
const benchUpdateAll = vi.fn(async () => ({ ok: true }))
const syncWorktree = vi.fn(async () => ({ ok: true }))
const benchAddMember = vi.fn(async () => ({ ok: true }))
const benchRemoveMember = vi.fn(async () => undefined)
const refreshWorkspaceViews = vi.fn(async () => undefined)
const cycleBenchConversation = vi.fn()
const openBenchTerminal = vi.fn(async () => null)
const startWorktreePipeline = vi.fn(async () => undefined)
const state = {
  activeTabId: 'outside',
  tabs: [] as TabState[],
  conversationPanes: new Map<string, ConversationPane>(),
  worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
  benchWorkspaces: new Map(),
  terminalActivities: new Map<string, import('../../../shared/terminal-activity').TerminalActivity>(),
  workspaceOperationLedger: new Map(),
  selectTab: (tabId: string): void => {
    state.activeTabId = tabId
    selectTab(tabId)
  },
  closeTab,
  openWorktreeConversation: vi.fn(async () => 'new-tab'),
  benchUpdateMember,
  benchUpdateAll,
  syncWorktree,
  benchAddMember,
  benchRemoveMember,
  refreshWorkspaceViews,
  cycleBenchConversation,
  openBenchTerminal,
  startWorktreePipeline,
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

const rInfo = vi.fn()
vi.mock('../../rendererLogger', () => ({
  rInfo: (...args: unknown[]) => rInfo(...args),
  rError: vi.fn(),
}))

vi.mock('../../components/WorktreePipelinePanel', () => ({ WorktreePipelinePanel: () => null }))
vi.mock('./InboxBenchBar', () => ({
  InboxBenchBar: ({ workspace, onAssemble, assembling }: {
    workspace: { sourceBranch: string }
    onAssemble(): void
    assembling: boolean
  }) => (
    <button
      data-testid={`inbox-bench-assemble-${workspace.sourceBranch}`}
      data-assembling={String(assembling)}
      onClick={onAssemble}
    >assemble</button>
  ),
}))
vi.mock('./InboxBenchMenu', () => ({ InboxBenchMenu: () => null }))
vi.mock('./InboxWorktreeRow', () => ({
  InboxWorktreeRow: ({ group, expanded, onOpen, syncing, onSync, updatingPin, pinUpdateLocked, onUpdatePin, onToggleMembership }: {
    group: { label: string; worktree: WorktreeInventoryEntry; membership?: { branchName: string } }
    expanded: boolean
    onOpen(): void
    syncing: boolean
    onSync(worktreePath: string, sourceBranch: string): void
    updatingPin: boolean
    pinUpdateLocked: boolean
    onUpdatePin(worktreePath: string, sourceBranch: string): void
    onToggleMembership(worktreePath: string, sourceBranch: string, enrolled: boolean): void
  }) => <div>
    <button data-testid="worktree-header" data-expanded={String(expanded)} onClick={onOpen}>{group.label}</button>
    <button
      data-testid="worktree-update-pin"
      data-updating={String(updatingPin)}
      data-locked={String(pinUpdateLocked)}
      onClick={() => onUpdatePin(group.worktree.worktreePath, group.worktree.sourceBranch ?? '')}
    >pin</button>
    <button
      data-testid="worktree-sync"
      data-syncing={String(syncing)}
      onClick={() => onSync(group.worktree.worktreePath, group.worktree.sourceBranch ?? '')}
    >sync</button>
    <button
      data-testid="worktree-toggle-membership"
      onClick={() => onToggleMembership(group.worktree.worktreePath, group.worktree.sourceBranch ?? '', !!group.membership)}
    >toggle</button>
  </div>,
}))

import { InboxNavigatorGroups } from './InboxNavigatorGroups'

function tab(id: string, lastActivityAt: number, status: TabState['status'] = 'idle'): TabState {
  return {
    id,
    title: id,
    customTitle: null,
    status,
    workingDirectory: '/repo/worktree',
    lastActivityAt,
  } as TabState
}

const worktree: WorktreeInventoryEntry = {
  worktreePath: '/repo/worktree',
  branchName: 'wt/example',
  sourceBranch: 'main',
  label: 'example',
  head: 'abc123',
  lastCommitSubject: 'change',
  isDirty: false,
  unlandedCommitCount: 0,
  needsSync: false,
  safeToDiscard: false,
}

function Harness({ project }: { project: InboxNavigatorProject }): React.JSX.Element {
  const group = project.groups[0]
  const groupKey = group ? `group:card:${group.key}` : `project:${project.project.key}`
  const initialCollapsed = group && group.kind !== 'bench' ? [groupKey] : []
  const [collapsed, setCollapsed] = useState(() => new Set(initialCollapsed))
  const toggle = (key: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return <InboxNavigatorGroups
    projects={[project]}
    collapsed={collapsed}
    onToggle={toggle}
    variant="card"
    selectedBench={{}}
    onSelectBench={() => {}}
    row={(item) => <div key={item.id} data-testid={`conversation-${item.id}`}>{item.title}</div>}
  />
}

describe('InboxNavigatorGroups worktree cycling', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    state.activeTabId = 'outside'
    state.tabs = [tab('older', 10), tab('newer', 20)]
    state.conversationPanes = new Map()
    state.worktreeInventory = new Map([['/repo', [worktree]]])
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('expands a collapsed worktree before selecting its first conversation', async () => {
    const project: InboxNavigatorProject = {
      project: { key: '/repo', name: 'repo' },
      groups: [{
        key: worktree.worktreePath,
        kind: 'worktree',
        label: 'example',
        tabs: state.tabs,
        worktree,
      }],
      flatTabs: [],
    }
    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={project} />) })

    const header = container.querySelector<HTMLElement>('[data-testid="worktree-header"]')!
    expect(header.dataset.expanded).toBe('false')
    expect(container.querySelector('[data-testid="conversation-newer"]')).toBeNull()

    await act(async () => { header.click() })

    expect(container.querySelector<HTMLElement>('[data-testid="worktree-header"]')?.dataset.expanded).toBe('true')
    expect(container.querySelector('[data-testid="conversation-newer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="conversation-older"]')).not.toBeNull()
    expect(selectTab).toHaveBeenCalledWith('newer')
    expect(rInfo).toHaveBeenCalledWith(
      'inbox.navigator',
      'expanded group before cycling conversations',
      expect.objectContaining({ group_kind: 'worktree', conversation_count: 2 }),
    )

    await act(async () => { root.unmount() })
  })

  it('expands a collapsed project before selecting its next conversation', async () => {
    const project: InboxNavigatorProject = {
      project: { key: '/repo', name: 'repo' },
      groups: [{
        key: worktree.worktreePath,
        kind: 'worktree',
        label: 'example',
        tabs: state.tabs,
        worktree,
      }],
      flatTabs: [],
    }
    const projectKey = 'project:/repo'
    function ProjectHarness(): React.JSX.Element {
      const [collapsedState, setCollapsedState] = useState(() => new Set([projectKey]))
      const toggle = (key: string): void => setCollapsedState((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return <InboxNavigatorGroups
        projects={[project]}
        collapsed={collapsedState}
        onToggle={toggle}
        variant="card"
        selectedBench={{}}
        onSelectBench={() => {}}
        row={(item) => <div key={item.id} data-testid={`conversation-${item.id}`}>{item.title}</div>}
      />
    }
    const root = createRoot(container)
    await act(async () => { root.render(<ProjectHarness />) })

    const header = container.querySelector<HTMLElement>(`[aria-expanded]`)!
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="conversation-newer"]')).toBeNull()

    await act(async () => { header.click() })

    expect(container.querySelector<HTMLElement>('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="conversation-newer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="conversation-older"]')).not.toBeNull()
    expect(selectTab).toHaveBeenCalledWith('newer')
    expect(rInfo).toHaveBeenCalledWith(
      'inbox.navigator',
      'expanded project before cycling conversations',
      expect.objectContaining({ project_key: '/repo', conversation_count: 2 }),
    )

    await act(async () => { root.unmount() })
  })

  it('keeps the selected source conversation visible, then expands and cycles', async () => {
    state.activeTabId = 'older'
    const project: InboxNavigatorProject = {
      project: { key: '/repo', name: 'repo' },
      groups: [{
        key: 'source:/repo',
        kind: 'source',
        label: 'Source Repository',
        tabs: state.tabs,
      }],
      flatTabs: [],
    }
    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={project} />) })

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Toggle Source Repository"]')!
    const header = toggle.parentElement!
    expect(container.querySelector('[data-testid="conversation-older"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="conversation-newer"]')).toBeNull()

    await act(async () => { header.click() })

    expect(container.querySelector('[data-testid="conversation-newer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="conversation-older"]')).not.toBeNull()
    expect(selectTab).toHaveBeenCalledWith('newer')
    expect(rInfo).toHaveBeenCalledWith(
      'inbox.navigator',
      'expanded group before cycling conversations',
      expect.objectContaining({ group_kind: 'source', conversation_count: 2 }),
    )

    await act(async () => { root.unmount() })
  })
})

describe('InboxNavigatorGroups worktree mutations', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    state.activeTabId = 'outside'
    state.tabs = []
    state.conversationPanes = new Map()
    state.worktreeInventory = new Map([['/repo', [worktree]]])
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('forwards row mutations without a mirror-local workspace refresh', async () => {
    const project: InboxNavigatorProject = {
      project: { key: '/repo', name: 'repo' },
      groups: [{ key: worktree.worktreePath, kind: 'worktree', label: 'example', tabs: [], worktree }],
      flatTabs: [],
    }
    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={project} />) })

    const pin = container.querySelector<HTMLButtonElement>('[data-testid="worktree-update-pin"]')!
    const sync = container.querySelector<HTMLButtonElement>('[data-testid="worktree-sync"]')!
    const membership = container.querySelector<HTMLButtonElement>('[data-testid="worktree-toggle-membership"]')!
    await act(async () => { pin.click(); sync.click(); membership.click() })

    expect(benchUpdateMember).toHaveBeenCalledWith('/repo', 'main', worktree.worktreePath)
    expect(syncWorktree).toHaveBeenCalledWith(worktree.worktreePath, 'main', '/repo')
    expect(benchAddMember).toHaveBeenCalledWith('/repo', 'main', worktree.worktreePath, worktree.branchName)
    expect(refreshWorkspaceViews).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})

describe('InboxNavigatorGroups bench terminal row', () => {
  let container: HTMLDivElement

  const workspace: IntegrationWorkspace = {
    repoPath: '/repo',
    sourceBranch: 'main',
    benchPath: '/bench/main',
    benchBranch: 'ion/bench/main',
    members: [],
    baseSha: '',
    lastBuiltAt: 0,
  }

  function benchProject(): InboxNavigatorProject {
    return {
      project: { key: '/repo', name: 'repo' },
      groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: [], workspace }],
      flatTabs: [],
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.activeTabId = 'outside'
    state.worktreeInventory = new Map()
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    state.terminalActivities = new Map()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  /**
   * Regression: 195263123c removed the ad-hoc terminal button that used to
   * render under the bench group and never replaced it -- the bench
   * terminal is a real occupant of the bench directory (`pickDirTerminal`
   * finds it) but is not a conversation, so `inbox-navigator.ts` filters it
   * out of `group.tabs` before groups are even built. Without a dedicated
   * row for it, a bench terminal simply vanished from the Inbox.
   */
  it('shows the bench terminal as a row when one is open', async () => {
    const terminal = {
      id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
      workingDirectory: workspace.benchPath, isTerminalOnly: true,
    } as TabState
    state.tabs = [terminal]

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const row = container.querySelector<HTMLElement>(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('Bench · main')

    await act(async () => { row!.click() })
    expect(selectTab).toHaveBeenCalledWith('bench-terminal')

    await act(async () => { root.unmount() })
  })

  /**
   * Regression: clicking the bench terminal made it the active conversation
   * (selectTab fired correctly) but the row itself never showed the accent
   * highlight every other selected row gets, because it never checked
   * activeTabId at all -- only hover/pressed drove its background. So the
   * click "worked" yet looked like nothing happened. The theme mock above
   * collapses every color token to the same string, so background cannot be
   * asserted here; fontWeight is a genuine, non-proxied DOM style this test
   * can actually pin.
   */
  it('shows the active highlight when the bench terminal is the selected tab', async () => {
    const terminal = {
      id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
      workingDirectory: workspace.benchPath, isTerminalOnly: true,
    } as TabState
    state.tabs = [terminal]
    state.activeTabId = 'bench-terminal'

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const row = container.querySelector<HTMLElement>(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)!
    const label = row.querySelector('span')!
    expect(label.style.fontWeight).toBe('600')

    await act(async () => { root.unmount() })
  })

  it('does not show the active highlight when the bench terminal is not selected', async () => {
    const terminal = {
      id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
      workingDirectory: workspace.benchPath, isTerminalOnly: true,
    } as TabState
    state.tabs = [terminal]
    state.activeTabId = 'outside'

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const row = container.querySelector<HTMLElement>(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)!
    const label = row.querySelector('span')!
    expect(label.style.fontWeight).toBe('400')

    await act(async () => { root.unmount() })
  })

  it('renders no terminal row when the bench has no open terminal', async () => {
    state.tabs = []
    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    expect(container.querySelector(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)).toBeNull()

    await act(async () => { root.unmount() })
  })

  /**
   * Closing a bench terminal is NOT the settle/un-settle flow the conversation
   * rows use -- a terminal-only tab has no Settled History entry, so there is
   * nothing for the operator to recover. The close affordance appears only on
   * hover (the row's own hover animation is what tells the operator this is a
   * button) and only while the terminal is idle: an in-flight foreground
   * command must not be killed by one accidental click, the same protection
   * `closeBlocked` gives the tab strip's X.
   */
  it('closes an idle bench terminal from a hover-revealed X, without settling', async () => {
    const terminal = {
      id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
      workingDirectory: workspace.benchPath, isTerminalOnly: true,
    } as TabState
    state.tabs = [terminal]
    state.terminalActivities = new Map()

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const row = container.querySelector<HTMLElement>(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)!
    expect(row.querySelector('[aria-label="Close terminal"]')).toBeNull()

    await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

    const closeButton = row.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')
    expect(closeButton).not.toBeNull()

    await act(async () => { closeButton!.click() })

    expect(closeTab).toHaveBeenCalledWith('bench-terminal')
    // Closing the terminal must never also select it -- the click has to stop
    // propagation to the row's own onClick (which calls selectTab).
    expect(selectTab).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })

  it('hides the close affordance while the bench terminal has a command running', async () => {
    const terminal = {
      id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
      workingDirectory: workspace.benchPath, isTerminalOnly: true,
    } as TabState
    state.tabs = [terminal]
    state.terminalActivities = new Map([['bench-terminal:instance-1', {
      key: 'bench-terminal:instance-1', tabId: 'bench-terminal', instanceId: 'instance-1',
      active: true, processLabel: 'npm', processIds: [1], applications: [],
    }]])

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const row = container.querySelector<HTMLElement>(`[data-testid="inbox-bench-terminal-${workspace.sourceBranch}"]`)!
    await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

    expect(row.querySelector('[aria-label="Close terminal"]')).toBeNull()

    await act(async () => { root.unmount() })
  })
})

/**
 * Regression: the Inbox bench header's spinning-arrows icon was purely
 * decorative -- it rendered next to "Bench · <branch>" looking exactly like
 * a button, but carried no onClick, so pressing it did nothing and it never
 * animated. The real "Assemble / Update Bench" verb only existed inside the
 * "..." menu. These tests pin that the icon now dispatches the same
 * `benchUpdateAll` action as the menu item, and that it reflects the
 * workspace operation ledger while an assembly for that bench is in flight.
 */
describe('InboxNavigatorGroups bench assemble button', () => {
  let container: HTMLDivElement

  const workspace: IntegrationWorkspace = {
    repoPath: '/repo',
    sourceBranch: 'main',
    benchPath: '/bench/main',
    benchBranch: 'ion/bench/main',
    members: [],
    baseSha: '',
    lastBuiltAt: 0,
  }

  function benchProject(): InboxNavigatorProject {
    return {
      project: { key: '/repo', name: 'repo' },
      groups: [{ key: `bench:${workspace.benchPath}`, kind: 'bench', label: 'Integration Bench · main', tabs: [], workspace }],
      flatTabs: [],
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.activeTabId = 'outside'
    state.tabs = []
    state.worktreeInventory = new Map()
    state.benchWorkspaces = new Map([['/repo', [workspace]]])
    state.workspaceOperationLedger = new Map()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('dispatches benchUpdateAll for this repo and branch when clicked', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const button = container.querySelector<HTMLButtonElement>(`[data-testid="inbox-bench-assemble-${workspace.sourceBranch}"]`)!
    expect(button.dataset.assembling).toBe('false')
    await act(async () => { button.click() })

    expect(benchUpdateAll).toHaveBeenCalledWith('/repo', 'main')

    await act(async () => { root.unmount() })
  })

  it('shows assembling while a matching operation is running in the ledger', async () => {
    state.workspaceOperationLedger = new Map([
      ['benchUpdateAll:1', { id: 'benchUpdateAll:1', action: 'benchUpdateAll', status: 'running', startedAt: Date.now(), repoPath: '/repo', sourceBranch: 'main' }],
    ])

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const button = container.querySelector<HTMLButtonElement>(`[data-testid="inbox-bench-assemble-${workspace.sourceBranch}"]`)!
    expect(button.dataset.assembling).toBe('true')

    await act(async () => { root.unmount() })
  })

  it('does not show assembling for a running operation against a different branch', async () => {
    state.workspaceOperationLedger = new Map([
      ['benchUpdateAll:1', { id: 'benchUpdateAll:1', action: 'benchUpdateAll', status: 'running', startedAt: Date.now(), repoPath: '/repo', sourceBranch: 'other' }],
    ])

    const root = createRoot(container)
    await act(async () => { root.render(<Harness project={benchProject()} />) })

    const button = container.querySelector<HTMLButtonElement>(`[data-testid="inbox-bench-assemble-${workspace.sourceBranch}"]`)!
    expect(button.dataset.assembling).toBe('false')

    await act(async () => { root.unmount() })
  })
})

