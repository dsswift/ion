/**
 * Row identity survives a server restart.
 *
 * A thin client asks for an older page by naming the first row it holds, and
 * the server finds that row in its own transcript by id. The id a client was
 * given before a server restart must therefore still name the same row after
 * it.
 *
 * Before this pin, the persisted message shape carried no id and the restore
 * path minted a fresh `crypto.randomUUID()` for every row, so every row's
 * identity changed at each restart.
 */
import { describe, it, expect } from 'vitest'
import { serializePersistedMessages } from '../serialize-conversation-pane'
import { mapPersistedMessages } from '../persisted-message-map'

describe('persisted conversation rows keep their canonical id', () => {
  it('round-trips the engine entry id through serialize → restore', () => {
    const runtime = [
      { id: 'u1a2b3c4', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'e5f6a7b8', role: 'assistant', content: 'Let me check.', timestamp: 2 },
      {
        id: 'e5f6a7b8:1', role: 'tool', content: 'ok', toolName: 'Bash',
        toolId: 'toolu_1', toolStatus: 'completed', timestamp: 2,
      },
    ]

    const restored = mapPersistedMessages(serializePersistedMessages(runtime))

    expect(restored.map((m) => m.id)).toEqual([
      'u1a2b3c4',
      'e5f6a7b8',
      'e5f6a7b8:1',
    ])
  })

  it('falls back to a fresh id for rows persisted before ids were written', () => {
    const legacy = [{ role: 'assistant', content: 'old row', timestamp: 1 }]

    const restored = mapPersistedMessages(legacy)

    expect(restored).toHaveLength(1)
    expect(restored[0].id).toBeTruthy()
    expect(restored[0].content).toBe('old row')
  })
})
