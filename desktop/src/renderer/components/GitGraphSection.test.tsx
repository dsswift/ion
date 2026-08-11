// @vitest-environment jsdom
import React, { useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))

import { useGitGraphFocus } from './git/useGitGraphFocus'
import type { GitCommit } from '../../shared/types'

const commit = (hash: string): GitCommit => ({
  hash: hash.slice(0, 8),
  fullHash: hash,
  parents: [],
  authorName: '',
  authorDate: '2026-01-01T00:00:00Z',
  subject: hash,
  refs: [],
})

interface HarnessProps {
  activeTabId: string
  directory: string
  headSha: string | null
  commits: GitCommit[]
  totalCount: number
  graphLoaded?: boolean
  loading?: boolean
}

function renderFocusHook(initial: HarnessProps) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const loadNextPage = vi.fn(async () => {})
  let setProps: (props: HarnessProps) => void
  let focus: ReturnType<typeof useGitGraphFocus>

  function Harness() {
    const [props, update] = useState(initial)
    setProps = update
    focus = useGitGraphFocus({
      ...props,
      branch: 'branch',
      filters: { search: '', author: '', path: '', refKind: 'all', dateAfter: '', dateBefore: '' },
      graphLoaded: props.graphLoaded ?? true,
      loading: props.loading ?? false,
      loadNextPage,
    })
    return null
  }

  act(() => { root.render(<Harness />) })
  return {
    get focus() { return focus! },
    loadNextPage,
    update(props: HarnessProps) { act(() => setProps!(props)) },
    unmount() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('useGitGraphFocus', () => {
  it('focuses checked-out commit when graph opens', () => {
    const hook = renderFocusHook({
      activeTabId: 'base-tab', directory: '/repo', headSha: 'base-head',
      commits: [commit('base-head')], totalCount: 1,
    })

    expect(hook.focus).toEqual(expect.objectContaining({ index: 0 }))
    hook.unmount()
  })

  it('focuses again after direct conversation switch in same worktree', () => {
    const commits = [commit('worktree-head')]
    const hook = renderFocusHook({
      activeTabId: 'worktree-tab-a', directory: '/repo/worktree', headSha: 'worktree-head', commits, totalCount: 1,
    })
    const firstKey = hook.focus?.key

    hook.update({
      activeTabId: 'worktree-tab-b', directory: '/repo/worktree', headSha: 'worktree-head', commits, totalCount: 1,
    })

    expect(hook.focus?.key).not.toBe(firstKey)
    expect(hook.focus?.index).toBe(0)
    hook.unmount()
  })

  it('loads next page until checked-out commit appears', () => {
    const hook = renderFocusHook({
      activeTabId: 'worktree-tab', directory: '/repo/worktree', headSha: 'worktree-head',
      commits: [commit('newer')], totalCount: 2,
    })

    expect(hook.loadNextPage).toHaveBeenCalledTimes(1)
    expect(hook.focus).toBeNull()

    hook.update({
      activeTabId: 'worktree-tab', directory: '/repo/worktree', headSha: 'worktree-head',
      commits: [commit('newer'), commit('worktree-head')], totalCount: 2,
    })

    expect(hook.focus?.index).toBe(1)
    hook.unmount()
  })

  it('does not repeat completed focus for ordinary graph refresh', () => {
    const commits = [commit('base-head')]
    const hook = renderFocusHook({
      activeTabId: 'base-tab', directory: '/repo', headSha: 'base-head', commits, totalCount: 1,
    })
    const focusKey = hook.focus?.key

    hook.update({
      activeTabId: 'base-tab', directory: '/repo', headSha: 'base-head', commits: [...commits], totalCount: 1,
    })

    expect(hook.focus?.key).toBe(focusKey)
    expect(hook.loadNextPage).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('finishes without focus when filters exclude checked-out commit', () => {
    const hook = renderFocusHook({
      activeTabId: 'base-tab', directory: '/repo', headSha: 'base-head',
      commits: [commit('other')], totalCount: 1,
    })

    expect(hook.focus).toBeNull()
    expect(hook.loadNextPage).not.toHaveBeenCalled()
    hook.unmount()
  })
})
