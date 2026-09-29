// @vitest-environment jsdom
/**
 * The Inbox row keeps its title line to the title. A conversation's color
 * tints the whole row instead of adding a dot or an icon, and the extension
 * and remote badges ride the second line after the directory, remote last.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  activeTabId: null as string | null,
  tabs: [] as TabState[],
  settledHistory: [] as TabState[],
  conversationPanes: new Map(),
  benchWorkspaces: new Map(),
  selectTab: vi.fn(),
  renameTab: vi.fn(),
}
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
}))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../preferences', () => ({ usePreferencesStore: (selector: (s: { inboxAutoSettleDays: number; engineProfiles: Array<{ id: string; name: string }> }) => unknown) => selector({ inboxAutoSettleDays: 0, engineProfiles: [{ id: 'profile-1', name: 'Chief of Staff' }] }) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('./ConversationHoverCard', () => ({ ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../components/git/Tooltip', () => ({ Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) => <span data-tooltip={text}>{children}</span> }))
vi.mock('../../host/host-instance', () => ({
  host: { deviceSettings: async () => ({ environments: [{ kind: 'paired', label: 'Grover', url: 'http://grover.local:7331', credentialRef: 'grover', via: 'lan', environmentId: 'grover' }] }), capabilities: () => ['local'] },
}))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn() }))

import { InboxRow } from './InboxRow'

function tab(overrides: Partial<TabState> = {}): TabState {
  return { id: 'tab-1', conversationId: 'conv-1', title: 'My conversation', customTitle: null, status: 'idle', workingDirectory: '/repo', ...overrides } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('InboxRow layout', () => {
  function lines(): { row: HTMLElement; title: HTMLElement; detail: HTMLElement } {
    const row = host.querySelector<HTMLElement>('[data-inbox-tab-id="tab-1"]')!
    const content = row.firstElementChild as HTMLElement
    return { row, title: content.children[0] as HTMLElement, detail: content.children[1] as HTMLElement }
  }

  it('tints the row with the conversation color and draws no color dot or icon', async () => {
    act(() => root.render(<InboxRow tab={tab({ pillColor: '#42a5f5' })} unread={false} woke={false} projectName="ion" variant="card" backgroundLiveness={null} />))
    await flush()
    const { row, title } = lines()
    expect(row.getAttribute('data-conversation-color')).toBe('#42a5f5')
    // jsdom normalizes the hex to rgb().
    expect(row.style.backgroundImage).toContain('rgb(66, 165, 245)')
    expect(host.querySelector('[aria-label="conversation color"]')).toBeNull()
    expect(title.querySelector('svg')).toBeNull()
  })

  it('leaves an uncolored row untinted', async () => {
    act(() => root.render(<InboxRow tab={tab()} unread={false} woke={false} projectName="ion" variant="card" backgroundLiveness={null} />))
    await flush()
    expect(lines().row.style.backgroundImage).toBe('')
  })

  it('puts the extension badge after the directory and the remote badge last, off the title line', async () => {
    act(() => root.render(<InboxRow tab={tab({ engineProfileId: 'profile-1', environmentId: 'grover' } as Partial<TabState>)} unread={false} woke={false} projectName="ion" variant="card" backgroundLiveness={null} />))
    await flush()
    const { title, detail } = lines()
    expect(title.textContent).toBe('My conversation')
    const parts = Array.from(detail.children).map((el) => el.textContent ?? '')
    expect(parts[0]).toBe('ion')
    expect(parts[1]).toBe('COS')
    expect(parts[parts.length - 1]).toContain('Grover')
  })
})
