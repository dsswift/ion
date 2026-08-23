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

afterEach(() => { document.body.replaceChildren() })

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
})
