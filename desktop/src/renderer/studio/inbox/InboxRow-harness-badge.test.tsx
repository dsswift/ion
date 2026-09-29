// @vitest-environment jsdom
/**
 * A conversation running under an engine profile wears an abbreviated
 * profile ("harness") badge on its Inbox row, so it does not look identical
 * to a plain one. This pins the badge in both row variants.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  activeTabId: null as string | null,
  conversationPanes: new Map(),
  benchWorkspaces: new Map(),
  selectTab: vi.fn(),
  renameTab: vi.fn(),
  unsnoozeTab: vi.fn(),
  snoozeTab: vi.fn(),
  markTabUnread: vi.fn(),
  pinTab: vi.fn(),
  unpinTab: vi.fn(),
  settleTab: vi.fn(async () => undefined),
  unsettleTab: vi.fn(async () => undefined),
  regenerateTabTitle: vi.fn(async () => undefined),
  deleteConversationTab: vi.fn(async () => undefined),
}

let engineProfiles: Array<{ id: string; name: string }> = []

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: { inboxAutoSettleDays: number; engineProfiles: typeof engineProfiles }) => unknown) =>
    selector({ inboxAutoSettleDays: 0, engineProfiles }),
}))
vi.mock('../../components/PopoverLayer', () => ({
  usePopoverLayer: () => null,
}))
vi.mock('./ConversationHoverCard', () => ({
  ConversationHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { InboxRow } from './InboxRow'

function tab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: 'conv-1',
    title: 'My conversation',
    customTitle: null,
    status: 'idle',
    workingDirectory: '/repo',
    ...overrides,
  } as TabState
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  engineProfiles = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxRow harness badge', () => {
  it('renders the abbreviated engine-profile name for a tab running an extension', () => {
    engineProfiles = [{ id: 'profile-1', name: 'Chief of Staff' }]
    act(() => root.render(
      <InboxRow tab={tab({ engineProfileId: 'profile-1' } as Partial<TabState>)} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
    ))
    expect(host.textContent).toContain('COS')
  })

  it('renders the abbreviated engine-profile name in the compact/slim variant too', () => {
    engineProfiles = [{ id: 'profile-1', name: 'Chief of Staff' }]
    act(() => root.render(
      <InboxRow tab={tab({ engineProfileId: 'profile-1' } as Partial<TabState>)} unread={false} woke={false} projectName={null} variant="slim" backgroundLiveness={null} />,
    ))
    expect(host.textContent).toContain('COS')
  })

  it('renders no badge for a plain conversation with no engine profile', () => {
    act(() => root.render(
      <InboxRow tab={tab()} unread={false} woke={false} projectName={null} variant="card" backgroundLiveness={null} />,
    ))
    expect(host.textContent).not.toContain('COS')
    expect(host.textContent).not.toContain('EXT')
  })
})
