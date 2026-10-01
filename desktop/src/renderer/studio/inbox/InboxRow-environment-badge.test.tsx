// @vitest-environment jsdom
/**
 * A conversation that lives on another Environment sits in the same Inbox
 * as local ones (ADR-033 union store) and wears a badge naming that
 * Environment; a local conversation wears none.
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
vi.mock('../../preferences', () => ({ usePreferencesStore: (selector: (s: { inboxAutoSettleDays: number; engineProfiles: never[] }) => unknown) => selector({ inboxAutoSettleDays: 0, engineProfiles: [] }) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('./ConversationHoverCard', () => ({ ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../components/git/Tooltip', () => ({ Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) => <span data-tooltip={text}>{children}</span> }))
vi.mock('../../host/host-instance', () => ({
  host: { deviceSettings: async () => ({ environments: [{ kind: 'paired', label: 'Oscar', url: 'http://oscar.local:7331', credentialRef: 'oscar', via: 'lan', environmentId: 'oscar' }] }), capabilities: () => ['local'] },
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

describe('InboxRow environment badge', () => {
  it('names the remote environment on its row, with the host on hover', async () => {
    act(() => root.render(<InboxRow tab={tab({ environmentId: 'oscar' })} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />))
    await flush()
    const badge = host.querySelector('[data-testid="environment-badge"]')
    expect(badge?.textContent).toContain('Oscar')
    expect(badge?.parentElement?.getAttribute('data-tooltip')).toContain('http://oscar.local:7331')
  })

  it('wears no badge for a local conversation', async () => {
    act(() => root.render(<InboxRow tab={tab()} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />))
    await flush()
    expect(host.querySelector('[data-testid="environment-badge"]')).toBeNull()
  })
})
