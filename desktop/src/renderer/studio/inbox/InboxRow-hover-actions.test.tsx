// @vitest-environment jsdom
/**
 * Hovering an Inbox card shows its quick actions. Settle shows for every
 * card, pinned or not; a pinned card adds Unpin beside it.
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
  settleTab: vi.fn(async () => {}),
  unpinTab: vi.fn(),
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
  host: { deviceSettings: async () => ({ environments: [{ kind: 'paired', label: 'Devbox', url: 'http://devbox.local:7331', credentialRef: 'devbox', via: 'lan', environmentId: 'devbox' }] }), capabilities: () => ['local'] },
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

describe('InboxRow hover actions', () => {
  async function hoverRow(overrides: Partial<TabState>): Promise<void> {
    act(() => root.render(<InboxRow tab={tab(overrides)} unread={false} woke={false} projectName="ion" variant="card" backgroundLiveness={null} />))
    await flush()
    const row = host.querySelector<HTMLElement>('[data-inbox-tab-id="tab-1"]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  }

  it('shows Settle on a pinned card and settles it on click', async () => {
    await hoverRow({ pinnedAt: 1 })
    const settle = host.querySelector<HTMLButtonElement>('[aria-label="Settle conversation"]')
    expect(settle).not.toBeNull()
    expect(host.querySelector('[aria-label="Unpin conversation"]')).not.toBeNull()
    act(() => settle!.click())
    expect(state.settleTab).toHaveBeenCalledWith('tab-1')
    expect(state.selectTab).not.toHaveBeenCalled()
  })

  it('shows Settle and no Unpin on an unpinned card', async () => {
    await hoverRow({})
    expect(host.querySelector('[aria-label="Settle conversation"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Unpin conversation"]')).toBeNull()
  })
})
