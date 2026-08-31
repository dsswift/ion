// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationWorkspace } from '../../../shared/types'
import type { DirConversation } from '../../../shared/worktree-conversations'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, {
    get: (_target, property) => property === 'warningFg'
      ? '#ffff00'
      : property === 'infoFg'
        ? '#0000ff'
        : property === 'textTertiary'
          ? '#808080'
          : '#000000',
  }),
}))
vi.mock('../../components/git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { InboxBenchBar } from './InboxBenchBar'

const workspace = { sourceBranch: 'main' } as IntegrationWorkspace
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(conversationCount: number, showSyncAll = false, assembling = false): void {
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
      showSyncAll={showSyncAll}
      statusText="no members"
      onAssemble={() => {}}
      assembling={assembling}
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

describe('InboxBenchBar actions', () => {
  it('shows a neutral hammer while bench assembly is ready', () => {
    render(0)
    const button = host.querySelector<HTMLButtonElement>('[data-testid="inbox-bench-assemble-main"]')
    expect(button?.querySelector('[data-testid="inbox-bench-build-icon"]')).not.toBeNull()
    expect(button?.style.color).toBe('rgb(128, 128, 128)')
    expect(button?.querySelector('[data-testid="inbox-bench-sync-icon"]')).toBeNull()
  })

  it('shows a blue spinner and Building text while bench assembly runs', () => {
    render(0, false, true)
    const button = host.querySelector<HTMLButtonElement>('[data-testid="inbox-bench-assemble-main"]')
    expect(button?.querySelector('[data-testid="inbox-bench-build-spinner"]')).not.toBeNull()
    expect(button?.textContent).toContain('Building…')
    expect(button?.style.color).toBe('rgb(0, 0, 255)')
    expect(button?.disabled).toBe(true)
  })

  it('hides Sync All when no worktree needs source updates', () => {
    render(0, false)
    expect(host.querySelector('[data-testid="inbox-bench-sync-all"]')).toBeNull()
  })

  it('shows the yellow sync action and count when worktrees need source updates', () => {
    render(0, true)
    const button = host.querySelector<HTMLButtonElement>('[data-testid="inbox-bench-sync-all"]')
    expect(button?.textContent).toContain('Sync All')
    expect(button?.style.color).toBe('rgb(255, 255, 0)')
    expect(button?.querySelector('[data-testid="inbox-bench-sync-icon"]')).not.toBeNull()
  })
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
