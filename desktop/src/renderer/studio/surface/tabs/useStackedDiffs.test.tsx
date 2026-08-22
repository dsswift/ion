// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useStackedDiffs } from './useStackedDiffs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface HookValue {
  diffs: Map<string, { state: string; diff: string }>
  fetchDiff: (filePath: string, staged: boolean) => void
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function renderHook(repoDir: string, revision: number): {
  result: () => HookValue
  rerender: (nextRepoDir: string, nextRevision: number) => void
  unmount: () => void
} {
  let current: HookValue | null = null
  function Host(props: { repoDir: string; revision: number }): null {
    current = useStackedDiffs(props.repoDir, props.revision)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = (nextRepoDir: string, nextRevision: number) => {
    act(() => root.render(<Host repoDir={nextRepoDir} revision={nextRevision} />))
  }
  render(repoDir, revision)
  return {
    result: () => {
      if (!current) throw new Error('hook not rendered')
      return current
    },
    rerender: render,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('useStackedDiffs', () => {
  beforeEach(() => {
    ;(window as unknown as { ion: unknown }).ion = { gitDiff: vi.fn() }
  })

  it('drops late old-repository response after binding changes', async () => {
    const oldRequest = deferred<{ diff: string }>()
    const currentRequest = deferred<{ diff: string }>()
    const gitDiff = (window as unknown as { ion: { gitDiff: ReturnType<typeof vi.fn> } }).ion.gitDiff
    gitDiff.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise)
    const hook = renderHook('/worktrees/ion', 1)

    act(() => hook.result().fetchDiff('old.ts', false))
    expect(gitDiff).toHaveBeenLastCalledWith('/worktrees/ion', 'old.ts', false)

    hook.rerender('/repos/ion-website', 2)
    act(() => hook.result().fetchDiff('site.ts', true))
    expect(gitDiff).toHaveBeenLastCalledWith('/repos/ion-website', 'site.ts', true)

    await act(async () => {
      oldRequest.resolve({ diff: 'old diff' })
      await Promise.resolve()
    })
    expect(hook.result().diffs.has('old.ts:false')).toBe(false)

    await act(async () => {
      currentRequest.resolve({ diff: 'current diff' })
      await Promise.resolve()
    })
    expect(hook.result().diffs.get('site.ts:true')).toMatchObject({ state: 'ready', diff: 'current diff' })
    hook.unmount()
  })
})
