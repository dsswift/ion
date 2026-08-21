// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  computePaneLayout: vi.fn(() => ({
    sizes: [
      { id: 'changes', total: 100, body: 72, expanded: true },
      { id: 'worktrees', total: 100, body: 72, expanded: true },
      { id: 'graph', total: 100, body: 72, expanded: true },
    ],
    sashes: [],
    total: 328,
  })),
  resolveBenchContextAcrossRepos: vi.fn(),
}))
let activeTab = { id: 'tab-1', workingDirectory: '/repo', worktree: null as Record<string, string> | null }

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    expandedUI: false,
    gitPanelChangesOpen: true,
    setGitPanelChangesOpen: vi.fn(),
    gitPanelGraphOpen: true,
    gitPanelWorktreesOpen: true,
    setGitPanelWorktreesOpen: vi.fn(),
    setGitPanelGraphOpen: vi.fn(),
    gitPanelPaneProportions: {},
    setGitPanelPaneProportions: vi.fn(),
    gitPanelHeight: null,
    setGitPanelHeight: vi.fn(),
    workspaceFolders: {},
  }),
  getState: () => ({ setGitChangesTreeView: vi.fn(), gitChangesTreeView: false }),
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      activeTabId: activeTab.id,
      tabs: [activeTab],
      benchWorkspaces: new Map(),
      worktreeInventory: new Map(),
    }),
    { getState: () => ({ setWorktreeUncommitted: vi.fn(), closeGitPanel: vi.fn() }) },
  ),
}))
vi.mock('../../stores/git', () => ({ useRepoState: () => ({ files: [], revision: 1, branch: 'main' }) }))
vi.mock('../../hooks/usePanelVerticalResize', () => ({ usePanelVerticalResize: () => ({ height: 480, renderHandle: () => null }) }))
vi.mock('../../hooks/useWindowGeometry', () => ({ useElementHeight: () => 320 }))
vi.mock('../GitGraphSection', () => ({ GitGraphSection: () => <div data-testid="git-graph" /> }))
vi.mock('../GitPanelRepoSection', () => ({ GitPanelRepoSection: () => <div /> }))
vi.mock('../WorktreeListSection', () => ({ WorktreeListSection: () => <div /> }))
vi.mock('../WorktreeOverlapLauncher', () => ({ WorktreeOverlapLauncher: () => null }))
vi.mock('../GitConflictBanner', () => ({ GitConflictBanner: () => null }))
vi.mock('../git/Sash', () => ({ Sash: () => null }))
vi.mock('../git/benchContext', () => ({ resolveBenchContextAcrossRepos: mocks.resolveBenchContextAcrossRepos }))
vi.mock('../../hooks/useWorkspaceRepos', () => ({ useWorkspaceRepos: () => ({ repos: [] }) }))
vi.mock('../../lib/file-open-router', () => ({ surfaceRouter: () => null }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../git/paneLayout', () => ({ SECTION_HEADER: 28, computePaneLayout: mocks.computePaneLayout }))
vi.mock('../hooks/usePaneSash', () => ({ usePaneSash: () => ({ onSashMouseDown: vi.fn(), isDragging: false }) }))

import { GitPanel } from '../GitPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GitPanel docked layout', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.clearAllMocks()
    activeTab = { id: 'tab-1', workingDirectory: '/repo', worktree: null }
    mocks.resolveBenchContextAcrossRepos.mockReturnValue(null)
    ;(window as unknown as { ion: { gitRefresh: (directory: string) => Promise<void> } }).ion = {
      gitRefresh: vi.fn().mockResolvedValue(undefined),
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(): void {
    act(() => root.render(<GitPanel docked />))
  }

  it('uses docked container height and keeps Graph for repo roots and worktrees', () => {
    render()
    expect(mocks.computePaneLayout).toHaveBeenLastCalledWith(expect.objectContaining({ height: 320, hidden: [] }))
    expect(host.querySelector('[data-testid="git-graph"]')).not.toBeNull()

    activeTab = {
      id: 'tab-1',
      workingDirectory: '/repo/worktree',
      worktree: { repoPath: '/repo', branchName: 'wt/test', sourceBranch: 'main', worktreePath: '/repo/worktree' },
    }
    render()
    expect(mocks.computePaneLayout).toHaveBeenLastCalledWith(expect.objectContaining({ height: 320, hidden: [] }))
    expect(host.querySelector('[data-testid="git-graph"]')).not.toBeNull()
  })

  it('hides Graph only when directory resolves to integration bench', () => {
    mocks.resolveBenchContextAcrossRepos.mockReturnValue({ repoPath: '/repo', sourceBranch: 'main', members: [] })
    activeTab = { id: 'tab-1', workingDirectory: '/bench', worktree: null }

    render()

    expect(mocks.computePaneLayout).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 320,
      hidden: ['changes', 'graph'],
    }))
    expect(host.querySelector('[data-testid="git-graph"]')).toBeNull()
  })
})
