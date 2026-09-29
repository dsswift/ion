// @vitest-environment jsdom
/**
 * The browser-host path for GitPanel. Separate from GitPanel.test.tsx, which
 * drives real ElectronStudioHost resolution via window.ion --
 * host-instance.ts caches its resolved host class for the module's lifetime
 * by design, so mocking host-instance directly here is what lets the test
 * supply a browser Studio client's capability list.
 *
 * Every git verb is bridged over the studio-wire on every host, so the panel
 * calls host.shell.git* unconditionally -- there is no capability gate.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  computePaneLayout: vi.fn(() => ({
    sizes: [
      { id: 'changes', total: 100, body: 72, expanded: true },
      { id: 'graph', total: 100, body: 72, expanded: true },
    ],
    sashes: [],
    total: 328,
  })),
  resolveBenchContextAcrossRepos: vi.fn(() => null),
  useWorkspaceRepos: vi.fn(() => ({ repos: [] })),
  gitRefresh: vi.fn().mockResolvedValue(undefined),
  capabilities: vi.fn<() => string[]>(),
}))

const activeTab = { id: 'tab-1', workingDirectory: '/repo', worktree: null as Record<string, string> | null }

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    gitPanelChangesOpen: true,
    setGitPanelChangesOpen: vi.fn(),
    gitPanelGraphOpen: true,
    setGitPanelGraphOpen: vi.fn(),
    gitPanelPaneProportions: {},
    setGitPanelPaneProportions: vi.fn(),
    gitPanelHeight: null,
    setGitPanelHeight: vi.fn(),
    workspaceFolders: {},
  }),
  getState: () => ({ setGitChangesTreeView: vi.fn(), gitChangesTreeView: false }),
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      activeTabId: activeTab.id,
      tabs: [activeTab],
      benchWorkspaces: new Map(),
    }),
    { getState: () => ({ setWorktreeUncommitted: vi.fn(), closeGitPanel: vi.fn() }) },
  ),
}))
vi.mock('@ion/server/store/git', () => ({ useRepoState: () => ({ files: [], revision: 1, branch: 'main' }) }))
vi.mock('../../hooks/usePanelVerticalResize', () => ({ usePanelVerticalResize: () => ({ height: 480, renderHandle: () => null }) }))
vi.mock('../../hooks/useWindowGeometry', () => ({ useElementHeight: () => 320 }))
vi.mock('../GitGraphSection', () => ({ GitGraphSection: () => <div data-testid="git-graph" /> }))
vi.mock('../GitPanelRepoSection', () => ({ GitPanelRepoSection: () => <div /> }))
vi.mock('../GitConflictBanner', () => ({ GitConflictBanner: () => null }))
vi.mock('../git/Sash', () => ({ Sash: () => null }))
vi.mock('../git/benchContext', () => ({ resolveBenchContextAcrossRepos: mocks.resolveBenchContextAcrossRepos }))
vi.mock('../../hooks/useWorkspaceRepos', () => ({ useWorkspaceRepos: mocks.useWorkspaceRepos }))
vi.mock('../../hooks/useProjectDir', () => ({ useProjectDir: (dir: string) => dir }))
vi.mock('../../lib/file-open-router', () => ({ surfaceRouter: () => null }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../git/paneLayout', () => ({ SECTION_HEADER: 28, computePaneLayout: mocks.computePaneLayout }))
vi.mock('../hooks/usePaneSash', () => ({ usePaneSash: () => ({ onSashMouseDown: vi.fn(), isDragging: false }) }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { gitRefresh: mocks.gitRefresh }, capabilities: mocks.capabilities },
}))

import { GitPanel } from '../GitPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GitPanel on a browser Studio client (git bridged over the studio-wire)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    mocks.gitRefresh.mockClear()
    mocks.capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('refreshes on mount', () => {
    act(() => root.render(<GitPanel docked />))
    expect(mocks.gitRefresh).toHaveBeenCalledWith('/repo')
  })

  it('leaves the refresh button enabled', () => {
    act(() => root.render(<GitPanel docked />))
    expect(container.querySelector('[title="Not available in the browser"]')).toBeNull()
    expect(container.querySelector('[title="Refresh"]')).not.toBeNull()
  })
})
