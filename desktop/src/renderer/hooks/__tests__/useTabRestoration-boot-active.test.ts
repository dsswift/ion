/**
 * Boot-active tab hydration — the restore-time counterpart to selectTab's
 * lazy-hydration trigger.
 *
 * Regression pin for the "boot-active tab shows only the bootstrap harness
 * row" bug: useTabRestoration activates the boot-active tab via a raw
 * `setState({ activeTabId })`, so selectTab (and its loadSkeletonMessages
 * trigger) never runs. A boot-active extension-hosted tab restored with
 * externalContentStatus: 'pending' therefore never hydrated — its real
 * conversation history (in the engine chain) never loaded, and only live
 * events (the extension's bootstrap harness message) were visible.
 *
 * hydrateBootActiveTab applies the same gate selectTab uses. These tests pin
 * that gate and the resolveBootActiveTabId ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { resolveBootActiveTabId, hydrateBootActiveTab } from '../useTabRestoration-helpers'
import { makeMainPane } from '../../stores/conversation-instance'
import type { ConversationPane } from '../../../shared/types-engine'

describe('resolveBootActiveTabId', () => {
  const restored = [
    { tabId: 'tab-a', sessionId: 'sess-a', index: 0 },
    { tabId: 'tab-b', sessionId: 'sess-b', index: 1 },
    { tabId: 'tab-c', sessionId: null, index: 2 },
  ]

  it('resolves by activeTabIndex first', () => {
    expect(resolveBootActiveTabId({ activeTabIndex: 1 }, restored)).toBe('tab-b')
  })

  it('falls back to activeSessionId when index does not match', () => {
    expect(resolveBootActiveTabId({ activeTabIndex: 99, activeSessionId: 'sess-a' }, restored)).toBe('tab-a')
  })

  it('falls back to activeSessionId when index is absent', () => {
    expect(resolveBootActiveTabId({ activeSessionId: 'sess-b' }, restored)).toBe('tab-b')
  })

  it('returns null when nothing matches', () => {
    expect(resolveBootActiveTabId({ activeTabIndex: 99, activeSessionId: 'nope' }, restored)).toBe(null)
    expect(resolveBootActiveTabId({}, restored)).toBe(null)
  })
})

describe('hydrateBootActiveTab', () => {
  const loadSkeletonMessages = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    loadSkeletonMessages.mockClear()
  })

  function makeState(paneOverrides: Record<string, unknown>, conversationId: string | null = 'conv-1') {
    return {
      tabs: [{ id: 'tab-1', conversationId }],
      conversationPanes: new Map<string, ConversationPane>([['tab-1', makeMainPane(paneOverrides)]]),
      loadSkeletonMessages,
    }
  }

  it('hydrates a pending boot-active tab (the regression case)', () => {
    // externalContentStatus 'pending' + historyHydrated false + a live harness
    // row already streamed in — exactly the restored boot-active tab shape.
    const s = makeState({
      messages: [{ id: 'live', role: 'harness', content: 'bootstrap', timestamp: 1 }],
      messageCount: 1,
      historyHydrated: false,
      externalContentStatus: 'pending',
    })
    hydrateBootActiveTab(s, 'tab-1')
    expect(loadSkeletonMessages).toHaveBeenCalledWith('tab-1')
  })

  it('hydrates a plain skeleton boot-active tab (empty messages, persisted count)', () => {
    const s = makeState({ messages: [], messageCount: 5, historyHydrated: false })
    hydrateBootActiveTab(s, 'tab-1')
    expect(loadSkeletonMessages).toHaveBeenCalledWith('tab-1')
  })

  it('skips an already-hydrated tab', () => {
    const s = makeState({ messages: [], messageCount: 5, historyHydrated: true })
    hydrateBootActiveTab(s, 'tab-1')
    expect(loadSkeletonMessages).not.toHaveBeenCalled()
  })

  it('skips a tab with no conversationId', () => {
    const s = makeState({ messages: [], messageCount: 5, historyHydrated: false }, null)
    hydrateBootActiveTab(s, 'tab-1')
    expect(loadSkeletonMessages).not.toHaveBeenCalled()
  })

  it('skips when the pane is missing', () => {
    const s = {
      tabs: [{ id: 'tab-1', conversationId: 'conv-1' }],
      conversationPanes: new Map<string, ConversationPane>(),
      loadSkeletonMessages,
    }
    hydrateBootActiveTab(s, 'tab-1')
    expect(loadSkeletonMessages).not.toHaveBeenCalled()
  })
})
