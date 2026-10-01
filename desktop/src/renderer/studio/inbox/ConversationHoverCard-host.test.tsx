// @vitest-environment jsdom
/**
 * The hover card names where a conversation runs on its Host row: another
 * environment by its label with the remote mark, a local conversation by
 * its execution host or this desktop. There is no separate Environment row.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

vi.mock('../connection/tab-environment', () => ({ tabEnvironmentId: (tab: { environmentId?: string }) => tab.environmentId ?? 'local' }))
vi.mock('../transfer/environment-label-cache', () => ({ useEnvironmentInfo: (id: string | null) => (id === 'env-devbox' ? { label: 'devbox', url: 'http://127.0.0.1:7331' } : null) }))
vi.mock('../../components/git/HoverCard', () => ({ HoverCard: ({ content }: { content: React.ReactNode }) => <div data-testid="card">{content}</div> }))

const { ConversationHoverCard } = await import('./ConversationHoverCard')

function tab(overrides: Partial<TabState> = {}): TabState {
  return { id: 't1', title: 'hello', workingDirectory: '/repo', status: 'idle', ...overrides } as TabState
}

describe('ConversationHoverCard host row', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  function labels(): string[] {
    return [...container.querySelectorAll('[data-testid="card"] > div > span:nth-child(odd)')].map((el) => el.textContent ?? '')
  }
  function valueOf(label: string): Element | null {
    const spans = [...container.querySelectorAll('[data-testid="card"] > div > span')]
    const index = spans.findIndex((el) => el.textContent === label)
    return index >= 0 ? spans[index + 1] : null
  }

  it('a conversation on another environment names it on the Host row with the remote mark, and has no Environment row', () => {
    act(() => root.render(<ConversationHoverCard tab={tab({ environmentId: 'env-devbox' })} benches={new Map()} inventory={new Map()}><span /></ConversationHoverCard>))
    expect(labels()).not.toContain('Environment')
    const host = valueOf('Host')
    expect(host?.textContent).toBe('devbox')
    const remote = host?.querySelector('[data-testid="hover-card-remote-host"]')
    expect(remote).not.toBeNull()
    expect(remote?.getAttribute('title')).toBe('http://127.0.0.1:7331')
    expect(remote?.querySelector('svg')).not.toBeNull()
  })

  it('a local conversation names its execution host, else this desktop, with no remote mark', () => {
    act(() => root.render(<ConversationHoverCard tab={tab()} benches={new Map()} inventory={new Map()}><span /></ConversationHoverCard>))
    expect(valueOf('Host')?.textContent).toBe('Local desktop')
    expect(container.querySelector('[data-testid="hover-card-remote-host"]')).toBeNull()
    act(() => root.render(<ConversationHoverCard tab={tab({ executionHost: 'build-box' })} benches={new Map()} inventory={new Map()}><span /></ConversationHoverCard>))
    expect(valueOf('Host')?.textContent).toBe('build-box')
  })
})
