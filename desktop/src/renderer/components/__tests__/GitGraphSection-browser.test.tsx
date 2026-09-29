// @vitest-environment jsdom
/**
 * The browser-host path for GitGraphSection. Every git verb is bridged over
 * the studio-wire on every host, so the component calls host.shell.git*
 * unconditionally -- there is no capability gate to skip on. Mocking
 * host-instance directly (see useGitRepo-browser.test.tsx for the pattern)
 * pins that a browser Studio client's capability list does not change this.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitGraph, gitStashList, capabilities } = vi.hoisted(() => ({
  gitGraph: vi.fn().mockResolvedValue({ isGitRepo: true, commits: [], totalCount: 0 }),
  gitStashList: vi.fn().mockResolvedValue({ stashes: [] }),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector({ activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] }), {
    getState: () => ({ finishWorktreeTab: vi.fn() }),
  }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ worktreeCompletionStrategy: 'pr' }),
}))
vi.mock('@ion/server/store/git', () => ({ useRepoState: () => ({ branch: 'main', head: { sha: 'abc123' } }) }))
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../git/useGitGraphFocus', () => ({ useGitGraphFocus: () => null }))
vi.mock('../../utils/gitGraphLayout', () => ({ computeGraphLayout: () => [] }))
vi.mock('../GitBranchPicker', () => ({ BranchPicker: () => <div data-testid="branch-picker" /> }))
vi.mock('../GitCommitPopup', () => ({ CommitPopup: () => null }))
vi.mock('../GitCommitContextMenu', () => ({ CommitContextMenu: () => null }))
vi.mock('../GitFinishWorkMenu', () => ({ FinishWorkContextMenu: () => null }))
vi.mock('../git/VirtualCommitList', () => ({ VirtualCommitList: () => <div data-testid="commit-list" /> }))
vi.mock('../git/GraphFilterBar', () => ({ GraphFilterBar: () => null, EMPTY_FILTERS: { search: '', author: '', path: '', refKind: 'all', dateAfter: '', dateBefore: '' } }))
vi.mock('../git/RebaseEditor', () => ({ RebaseEditor: () => null }))
vi.mock('../FloatingPanel', () => ({ FloatingPanel: () => null }))
vi.mock('../git/DiffPane', () => ({ DiffPane: () => null }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { gitGraph, gitStashList }, capabilities },
}))

import { GitGraphSection } from '../GitGraphSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(container: HTMLDivElement): ReturnType<typeof createRoot> {
  const root = createRoot(container)
  act(() => {
    root.render(
      <GitGraphSection directory="/repo" onRefresh={() => {}} refreshKey={0} worktree={null} hasUncommittedChanges={false} />,
    )
  })
  return root
}

describe('GitGraphSection on a browser Studio client (git bridged over the studio-wire)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    gitGraph.mockClear()
    gitStashList.mockClear()
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    container = document.createElement('div')
    document.body.appendChild(container)
    root = render(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('loads the graph on mount', async () => {
    expect(gitGraph).toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
  })

  it('loads stashes on mount', () => {
    expect(gitStashList).toHaveBeenCalledWith('/repo')
  })

  it('leaves the fetch/pull/push buttons enabled', () => {
    expect(container.querySelector('[title="Not available in the browser"]')).toBeNull()
  })
})
