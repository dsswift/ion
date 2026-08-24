/**
 * The desktop content file must round-trip a turn's authorship classification.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 *
 * A conversation is rebuilt from the desktop's own content file on restart —
 * in BOTH presentations. So a field the serializer drops, or the restore
 * mapper ignores, is gone from the transcript on every later reopen, even
 * though the engine store on disk still holds it.
 *
 * That is what removed the Guided Questions frame: the classification was
 * correct in the engine's conversation file, correct in the live message, and
 * correct in the Overlay at submit time — and absent from the persisted shape
 * entirely, so every reopen rendered the submission as an ordinary user
 * bubble.
 *
 * The test is a ROUND TRIP on purpose. Both halves were broken here, and
 * asserting either one alone would still pass while the pair stayed lossy.
 */
import { describe, it, expect } from 'vitest'
import { serializePersistedMessages } from './serialize-conversation-pane'
import { mapPersistedMessages } from './persisted-message-map'
import type { Message } from '../../shared/types'

function userTurn(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content: 'My answers to "Scope": ...',
    timestamp: 1,
    ...overrides,
  } as Message
}

describe('content-file round trip — injectionKind', () => {
  it('survives serialize → restore for a questions submission', () => {
    const saved = serializePersistedMessages([userTurn({ injectionKind: 'structured_answer' })])
    expect(saved[0].injectionKind).toBe('structured_answer')

    const restored = mapPersistedMessages(saved)
    expect(restored[0].injectionKind).toBe('structured_answer')
  })

  it('leaves an ordinary typed turn unclassified', () => {
    // The guard against over-tagging: only a real submission carries the
    // field, so the frame cannot leak onto normal messages after a restart.
    const saved = serializePersistedMessages([userTurn()])
    expect(saved[0].injectionKind).toBeUndefined()

    const restored = mapPersistedMessages(saved)
    expect(restored[0].injectionKind).toBeUndefined()
  })

  it('keeps the classification alongside the answer content and attachments', () => {
    // The submission's images belong to the same turn; losing either the
    // content or the classification breaks the framed rendering.
    const saved = serializePersistedMessages([
      userTurn({
        injectionKind: 'structured_answer',
        attachments: [{ id: '/tmp/a.png', type: 'image', name: 'a.png', path: '/tmp/a.png' }],
      }),
    ])
    const restored = mapPersistedMessages(saved)

    expect(restored[0].injectionKind).toBe('structured_answer')
    expect(restored[0].content).toContain('My answers')
    expect(restored[0].attachments?.[0]?.path).toBe('/tmp/a.png')
  })
})
