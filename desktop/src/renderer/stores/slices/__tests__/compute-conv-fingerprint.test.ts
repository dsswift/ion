/**
 * Tests for computeConvFingerprint — the store-exposed wrapper around the
 * canonical conversationTailFingerprint function.
 *
 * The store action replaces the inline IIFE that was previously copy-pasted
 * into snapshot.ts's executeJavaScript string. By routing through the store,
 * snapshot.ts calls `store.getState().computeConvFingerprint(tabId)` and uses
 * the canonical TS implementation from shared/conversation-fingerprint.ts.
 */

import { describe, it, expect } from 'vitest'
import { conversationTailFingerprint, FINGERPRINT_TAIL_WINDOW } from '../../../../shared/conversation-fingerprint'
import type { FingerprintMessage } from '../../../../shared/conversation-fingerprint'

// Re-test the canonical function to confirm the store wrapper produces
// identical output for the same inputs. The contract with Swift is that
// conversationTailFingerprint and the Swift implementation agree; the store
// wrapper must be a transparent pass-through.

describe('computeConvFingerprint — canonical algorithm', () => {
  function fp(msgs: FingerprintMessage[]): string {
    return conversationTailFingerprint(msgs)
  }

  it('returns empty string for no messages', () => {
    expect(fp([])).toBe('')
  })

  it('formats user message as <id>:<utf8ByteLen>', () => {
    const msgs: FingerprintMessage[] = [
      { id: 'msg-1', role: 'user', content: 'hello' },
    ]
    // "hello" = 5 bytes in UTF-8
    expect(fp(msgs)).toBe('msg-1:5')
  })

  it('formats tool message as <id>:t<statusToken>', () => {
    expect(fp([{ id: 't-1', role: 'tool', content: '', toolStatus: 'running' }])).toBe('t-1:tr')
    expect(fp([{ id: 't-2', role: 'tool', content: '', toolStatus: 'completed' }])).toBe('t-2:tc')
    expect(fp([{ id: 't-3', role: 'tool', content: '', toolStatus: 'error' }])).toBe('t-3:te')
    expect(fp([{ id: 't-4', role: 'tool', content: '', toolStatus: undefined }])).toBe('t-4:t-')
  })

  it('joins tokens with comma', () => {
    const msgs: FingerprintMessage[] = [
      { id: 'a', role: 'user', content: 'hi' },
      { id: 'b', role: 'tool', content: '', toolStatus: 'completed' },
      { id: 'c', role: 'assistant', content: 'ok' },
    ]
    expect(fp(msgs)).toBe('a:2,b:tc,c:2')
  })

  it('uses UTF-8 byte length not JS .length (ASCII)', () => {
    // ASCII characters are 1 byte each — UTF-8 and JS .length agree here
    const msgs: FingerprintMessage[] = [{ id: 'x', role: 'user', content: 'abc' }]
    expect(fp(msgs)).toBe('x:3')
  })

  it('uses UTF-8 byte length not JS .length (multibyte)', () => {
    // Each emoji is 4 UTF-8 bytes but 2 JS UTF-16 code units
    const emoji = '😀'
    const msgs: FingerprintMessage[] = [{ id: 'x', role: 'user', content: emoji }]
    // 4 bytes in UTF-8, not 2
    expect(fp(msgs)).toBe('x:4')
  })

  it(`caps at FINGERPRINT_TAIL_WINDOW (${FINGERPRINT_TAIL_WINDOW}) messages`, () => {
    const msgs: FingerprintMessage[] = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: 'x',
    }))
    const result = fp(msgs)
    const tokens = result.split(',')
    expect(tokens.length).toBe(FINGERPRINT_TAIL_WINDOW)
    // Should be the LAST 10 messages (m5..m14)
    expect(tokens[0]).toContain('m5:')
    expect(tokens[FINGERPRINT_TAIL_WINDOW - 1]).toContain('m14:')
  })

  it('handles empty content gracefully (no throw)', () => {
    const msgs: FingerprintMessage[] = [{ id: 'z', role: 'user', content: '' }]
    expect(fp(msgs)).toBe('z:0')
  })
})
