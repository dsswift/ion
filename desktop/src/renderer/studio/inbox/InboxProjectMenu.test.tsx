// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#111111' }),
}))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../hooks/useOutsideDismiss', () => ({ useOutsideDismiss: () => {} }))
vi.mock('../../hooks/useAnchoredPopover', () => ({
  useAnchoredPopover: () => ({ left: 10, top: 20, ready: true, ref: () => {} }),
}))
vi.mock('../../components/ContextMenuItem', () => ({
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick(): void }) => <button onClick={onClick}>{children}</button>,
}))

import { InboxProjectMenu } from './InboxProjectMenu'
import { policyStore } from '../connection/policy-store'

afterEach(() => { document.body.replaceChildren(); policyStore._resetForTest() })

describe('InboxProjectMenu', () => {
  it('routes project conversation creation into the unified picker', async () => {
    const onNewConversation = vi.fn()
    const onNewWorktreeConversation = vi.fn()
    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<InboxProjectMenu
        anchor={{ x: 30, y: 40 }}
        environmentId="local"
        onNewConversation={onNewConversation}
        onNewWorktreeConversation={onNewWorktreeConversation}
        onClose={onClose}
      />)
    })

    const buttons = [...document.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['New conversation', 'New conversation in worktree'])
    await act(async () => { buttons[0].click() })
    expect(onNewConversation).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => { buttons[1].click() })
    expect(onNewWorktreeConversation).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })

  it('offers no worktree conversation on a machine that does not offer worktrees', async () => {
    policyStore.setDeveloperSurfaces('env-finance', { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: false })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<InboxProjectMenu
        anchor={{ x: 30, y: 40 }}
        environmentId="env-finance"
        onNewConversation={vi.fn()}
        onNewWorktreeConversation={vi.fn()}
        onClose={vi.fn()}
      />)
    })
    expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['New conversation'])
    await act(async () => { root.unmount() })
  })
})
