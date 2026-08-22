// @vitest-environment jsdom
/**
 * useGitRepo subscription refcount (F5): two same-window consumers of one
 * repo must produce ONE gitSubscribe, and the first unmount must NOT
 * unsubscribe — main's subscription map is keyed webContentsId::repoPath
 * without a refcount, so an early unsubscribe kills delivery for every
 * remaining subscriber in the window (StatusBar vs GitPanel collision).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../../stores/git', () => ({
  useGitStore: {
    getState: () => ({ applySnapshot: vi.fn(), applyEvent: vi.fn() }),
  },
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { activeTabId: string }) => unknown) => selector({ activeTabId: 'tab-1' }),
    { getState: () => ({ activeTabId: 'tab-1' }) },
  ),
}))

import { useGitRepo, _subscriberCount } from '../useGitRepo'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gitSubscribeMock = vi.fn().mockResolvedValue({ snapshot: null })
const gitUnsubscribeMock = vi.fn().mockResolvedValue(undefined)
const gitRefreshMock = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  gitSubscribeMock.mockClear()
  gitUnsubscribeMock.mockClear()
  gitRefreshMock.mockClear()
  ;(window as unknown as { ion: unknown }).ion = {
    gitSubscribe: gitSubscribeMock,
    gitUnsubscribe: gitUnsubscribeMock,
    gitRefresh: gitRefreshMock,
    onGitEvent: vi.fn(() => () => undefined),
  }
})

function Consumer({ dir }: { dir: string }): null {
  useGitRepo(dir, true)
  return null
}

function mount(children: React.ReactNode): { unmount: () => void; render: (n: React.ReactNode) => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(children)
  })
  return {
    render: (n) => {
      act(() => {
        root.render(n)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('useGitRepo refcount', () => {
  it('two consumers, one repo → one subscribe; unsubscribe only at zero', () => {
    const h = mount(
      <>
        <Consumer dir="/repo" />
        <Consumer dir="/repo" />
      </>,
    )
    expect(gitSubscribeMock).toHaveBeenCalledTimes(1)
    expect(_subscriberCount('/repo')).toBe(2)

    // Drop to one consumer: NO unsubscribe yet.
    h.render(<Consumer dir="/repo" />)
    expect(gitUnsubscribeMock).not.toHaveBeenCalled()
    expect(_subscriberCount('/repo')).toBe(1)

    // Last consumer leaves: unsubscribe fires once.
    h.unmount()
    expect(gitUnsubscribeMock).toHaveBeenCalledTimes(1)
    expect(_subscriberCount('/repo')).toBe(0)
  })

  it('distinct repos subscribe independently', () => {
    const h = mount(
      <>
        <Consumer dir="/repo-a" />
        <Consumer dir="/repo-b" />
      </>,
    )
    expect(gitSubscribeMock).toHaveBeenCalledTimes(2)
    h.unmount()
    expect(gitUnsubscribeMock).toHaveBeenCalledTimes(2)
  })
})
