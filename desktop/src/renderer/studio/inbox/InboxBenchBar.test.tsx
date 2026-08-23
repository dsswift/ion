// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationWorkspace } from '../../../shared/types'
import type { DirConversation } from '../../../shared/worktree-conversations'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../components/git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { InboxBenchBar } from './InboxBenchBar'

const workspace = { sourceBranch: 'main' } as IntegrationWorkspace
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(conversationCount: number): void {
  const conversations = Array.from({ length: conversationCount }, (_, index) => ({
    tabId: `tab-${index}`,
    title: `Conversation ${index}`,
    status: 'idle',
    index,
  })) as DirConversation[]
  act(() => root.render(
    <InboxBenchBar
      workspace={workspace}
      conversations={conversations}
      expanded
      onToggle={() => {}}
      onCycle={() => {}}
      onOpenTerminal={() => {}}
      onMenu={() => {}}
      onSyncAll={() => {}}
      statusText="no members"
      onAssemble={() => {}}
      assembling={false}
    />,
  ))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxBenchBar conversation count', () => {
  it('omits the count when the bench has no conversations', () => {
    render(0)
    expect(host.querySelector('[data-testid="inbox-bench-conversation-count"]')).toBeNull()
  })

  it('shows the count when the bench has conversations', () => {
    render(2)
    expect(host.querySelector('[data-testid="inbox-bench-conversation-count"]')?.textContent).toBe('2')
  })
})
