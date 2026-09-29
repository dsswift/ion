// @vitest-environment jsdom
/** A document chip on a user message opens that document for its own conversation. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const openAttachment = vi.fn(async () => {})
vi.mock('../../lib/open-attachment', () => ({
  openAttachment: (...a: unknown[]) => openAttachment(...(a as [])),
  attachmentOpenKind: () => 'native',
}))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ activeTabId: 'other-tab' }) } }))
vi.mock('../../rendererLogger', () => ({ rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

import { MessageFileChips } from './MessageFileChips'

describe('MessageFileChips', () => {
  it('opens the clicked document for the message\'s conversation, not the active one', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(
      <MessageFileChips
        content="[Attached file: /srv/ab.docx]"
        attachments={[{ id: 'a1', type: 'file', name: 'Report.docx', path: '/srv/ab.docx' }]}
        tabId="tab-1"
      />,
    ))
    const chip = container.querySelector<HTMLButtonElement>('[data-message-file-chip]')!
    act(() => chip.click())
    expect(openAttachment).toHaveBeenCalledWith('tab-1', expect.objectContaining({ name: 'Report.docx', path: '/srv/ab.docx' }))
    act(() => root.unmount())
  })
})
