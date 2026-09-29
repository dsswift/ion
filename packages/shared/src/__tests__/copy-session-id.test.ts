/**
 * copy-session-id — regression coverage for "Copy session id is empty on a
 * fresh tab".
 *
 * The reported bug: immediately after a session tab is created (plain or
 * extension), "Copy session id" copied nothing because the conversation id only
 * arrived with the first prompt's session_init. The fix captures the
 * engine-minted id onto the tab + main instance at tab-creation time
 * (engine-slice-create.ts `_captureMintedConversationId`), so the copy-payload
 * derivation yields a real id with no prompt sent.
 *
 * These tests pin the copy-payload derivation (`computeSessionIdCopyPayload`)
 * against the tab/instance shapes a freshly-created tab holds AFTER the capture.
 * They go red on the unfixed code: without the create-time capture, the tab's
 * conversationId/lastKnownSessionId are null and the instance's conversationIds
 * is empty, so the helper returns null ("nothing to copy") — exactly the bug.
 */

import { describe, it, expect } from 'vitest'
import { computeSessionIdCopyPayload, orderedSessionIds } from '../tab-predicates'

describe('computeSessionIdCopyPayload — fresh-tab regression', () => {
  it('plain tab: returns the engine-minted id captured at creation', () => {
    // Shape of a freshly-created plain tab after _captureMintedConversationId.
    const tab = {
      engineProfileId: null,
      conversationId: '1780000000000-aaaaaaaaaaaa',
      lastKnownSessionId: '1780000000000-aaaaaaaaaaaa',
    }
    expect(computeSessionIdCopyPayload(tab, null)).toBe('1780000000000-aaaaaaaaaaaa')
  })

  it('plain tab: returns null when no id is present (the pre-fix bug state)', () => {
    const tab = { engineProfileId: null, conversationId: null, lastKnownSessionId: null }
    expect(computeSessionIdCopyPayload(tab, null)).toBeNull()
  })

  it('extension tab: returns the instance conversationIds captured at creation', () => {
    const tab = { engineProfileId: 'profile-1', conversationId: '1780000000001-bbbbbbbbbbbb', lastKnownSessionId: '1780000000001-bbbbbbbbbbbb' }
    const inst = { conversationIds: ['1780000000001-bbbbbbbbbbbb'], statusFields: null }
    expect(computeSessionIdCopyPayload(tab, inst)).toBe('1780000000001-bbbbbbbbbbbb')
  })

  it('extension tab: returns null when the instance has no ids yet (the pre-fix bug state)', () => {
    const tab = { engineProfileId: 'profile-1', conversationId: null, lastKnownSessionId: null }
    const inst = { conversationIds: [], statusFields: null }
    expect(computeSessionIdCopyPayload(tab, inst)).toBeNull()
  })

  it('extension tab: unions the live statusFields.sessionId with historical ids', () => {
    const tab = { engineProfileId: 'profile-1' }
    const inst = { conversationIds: ['conv-old'], statusFields: { sessionId: 'conv-live' } }
    expect(computeSessionIdCopyPayload(tab, inst)).toBe('conv-old\nconv-live')
  })

  it('keeps the full chain in historical-to-current order and removes duplicates', () => {
    expect(orderedSessionIds(
      {
        engineProfileId: 'profile-1',
        sessionIds: ['oldest'],
        historicalSessionIds: ['oldest', 'older'],
        lastKnownSessionId: 'previous',
        conversationId: 'current',
      },
      { conversationIds: ['older', 'ledger'], statusFields: { sessionId: 'live' } },
    )).toEqual(['oldest', 'older', 'ledger', 'previous', 'current', 'live'])
  })

  it('extension tab: does not duplicate the live id when already in conversationIds', () => {
    const tab = { engineProfileId: 'profile-1' }
    const inst = { conversationIds: ['conv-live'], statusFields: { sessionId: 'conv-live' } }
    expect(computeSessionIdCopyPayload(tab, inst)).toBe('conv-live')
  })
})
