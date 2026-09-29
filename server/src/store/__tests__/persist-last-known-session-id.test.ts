/**
 * Tests for resolvePersistedLastKnownSessionId — Layer 3 data-integrity backstop
 * for the "agent starts fresh after restart" data-loss regression.
 *
 * A transient empty / engine-minted conversationId must never erase the tab's
 * ability to resume its original conversation. The last real id the tab ever
 * held survives in lastKnownSessionId so restore can recover it.
 *
 * Regression contract: removing the historicalSessionIds / instanceConversationIds
 * fallbacks makes the "recovers from history / instance chain" cases go red.
 */

import { describe, it, expect } from 'vitest'
import { resolvePersistedLastKnownSessionId } from '../serialize-conversation-pane'

describe('resolvePersistedLastKnownSessionId — preserve the last real id', () => {
  it('keeps an existing lastKnownSessionId (canonical last real id)', () => {
    const out = resolvePersistedLastKnownSessionId({
      conversationId: 'minted-empty',
      lastKnownSessionId: 'real-prior',
      historicalSessionIds: [],
      instanceConversationIds: undefined,
    })
    expect(out).toBe('real-prior')
  })

  it('uses conversationId when no lastKnownSessionId exists yet', () => {
    const out = resolvePersistedLastKnownSessionId({
      conversationId: 'live-conv',
      lastKnownSessionId: null,
      historicalSessionIds: [],
      instanceConversationIds: undefined,
    })
    expect(out).toBe('live-conv')
  })

  it('recovers the most-recent historicalSessionIds entry when both ids are empty', () => {
    const out = resolvePersistedLastKnownSessionId({
      conversationId: null,
      lastKnownSessionId: undefined,
      historicalSessionIds: ['old-1', 'old-2'],
      instanceConversationIds: undefined,
    })
    expect(out).toBe('old-2')
  })

  it('recovers the instance chain id as a last resort', () => {
    const out = resolvePersistedLastKnownSessionId({
      conversationId: null,
      lastKnownSessionId: undefined,
      historicalSessionIds: [],
      instanceConversationIds: ['chain-1', 'chain-2'],
    })
    expect(out).toBe('chain-2')
  })

  it('returns undefined for a genuinely sessionless tab', () => {
    const out = resolvePersistedLastKnownSessionId({
      conversationId: null,
      lastKnownSessionId: undefined,
      historicalSessionIds: [],
      instanceConversationIds: [],
    })
    expect(out).toBeUndefined()
  })

  it('does NOT let an empty conversationId erase a known historical id', () => {
    // The exact orphaning scenario: live conversationId was clobbered to empty,
    // but the tab had a real prior conversation in history.
    const out = resolvePersistedLastKnownSessionId({
      conversationId: '',
      lastKnownSessionId: undefined,
      historicalSessionIds: ['1782008390599-f50ac9c8b3c2'],
      instanceConversationIds: undefined,
    })
    expect(out).toBe('1782008390599-f50ac9c8b3c2')
  })
})
