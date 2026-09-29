// @vitest-environment jsdom
/**
 * The browser-host path for useGitRepo. Separate from
 * useGitRepo-refcount.test.tsx, which drives real ElectronStudioHost
 * resolution via window.ion -- host-instance.ts caches its resolved host
 * class for the module's lifetime by design, so mocking host-instance
 * directly here is what lets the test supply a browser Studio client's
 * capability list.
 *
 * Every git verb is bridged over the studio-wire on every host, so the hook
 * subscribes unconditionally -- there is no capability gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const { gitSubscribe, gitUnsubscribe, gitRefresh, onGitEvent, capabilities } = vi.hoisted(() => ({
  gitSubscribe: vi.fn().mockResolvedValue({ snapshot: null }),
  gitUnsubscribe: vi.fn().mockResolvedValue(undefined),
  gitRefresh: vi.fn().mockResolvedValue(undefined),
  onGitEvent: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../host/host-instance', () => ({
  host: { shell: { gitSubscribe, gitUnsubscribe, gitRefresh, onGitEvent }, capabilities },
}))
vi.mock('@ion/server/store/git', () => ({
  useGitStore: { getState: () => ({ applySnapshot: vi.fn(), applyEvent: vi.fn() }) },
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { activeTabId: string }) => unknown) => selector({ activeTabId: 'tab-1' }),
    { getState: () => ({ activeTabId: 'tab-1' }) },
  ),
}))

import { useGitRepo, _subscriberCount } from '../useGitRepo'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({ dir }: { dir: string }): null {
  useGitRepo(dir, true)
  return null
}

beforeEach(() => {
  gitSubscribe.mockClear()
  gitUnsubscribe.mockClear()
  gitRefresh.mockClear()
  onGitEvent.mockClear()
})

describe('useGitRepo on a browser Studio client (git bridged over the studio-wire)', () => {
  it('subscribes over host.shell.git* and releases on unmount', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<Consumer dir="/repo" />)
    })
    expect(gitSubscribe).toHaveBeenCalledTimes(1)
    expect(onGitEvent).toHaveBeenCalledTimes(1)
    expect(_subscriberCount('/repo')).toBe(1)
    act(() => root.unmount())
    expect(gitUnsubscribe).toHaveBeenCalledTimes(1)
    expect(_subscriberCount('/repo')).toBe(0)
    container.remove()
  })
})
