// @vitest-environment jsdom
/**
 * The browser-host path for GitChangesSection. Every git verb is bridged over
 * the studio-wire on every host, so the component calls host.shell.git*
 * unconditionally -- there is no capability gate to skip on. Mocking
 * host-instance directly (see useGitRepo-browser.test.tsx for the pattern)
 * pins that a browser Studio client's capability list does not change this.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitStashList, gitStage, capabilities } = vi.hoisted(() => ({
  gitStashList: vi.fn().mockResolvedValue({ stashes: [] }),
  gitStage: vi.fn().mockResolvedValue({ ok: true }),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('@ion/server/store/git', () => ({ useRepoGroups: () => null }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn() }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { gitStashList, gitStage }, capabilities },
}))

import { GitChangesSection } from '../GitChangesSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(container: HTMLDivElement): ReturnType<typeof createRoot> {
  const root = createRoot(container)
  act(() => {
    root.render(
      <GitChangesSection
        directory="/repo"
        files={[{ path: 'a.txt', staged: false, status: 'modified' } as never]}
        onRefresh={() => {}}
        treeView={false}
      />,
    )
  })
  return root
}

describe('GitChangesSection on a browser Studio client (git bridged over the studio-wire)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    gitStashList.mockClear()
    gitStage.mockClear()
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    container = document.createElement('div')
    document.body.appendChild(container)
    root = render(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('loads stashes on mount', () => {
    expect(gitStashList).toHaveBeenCalledWith('/repo')
  })

  it('stage-all click calls host.shell.gitStage', () => {
    const stageAllButton = container.querySelector('[title="Stage all"] button') as HTMLButtonElement | null
    expect(stageAllButton).not.toBeNull()
    act(() => stageAllButton?.click())
    expect(gitStage).toHaveBeenCalledWith('/repo', ['a.txt'])
  })
})
