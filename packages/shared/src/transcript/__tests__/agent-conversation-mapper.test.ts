// Unit tests for agent-conversation-mapper.ts — stable per-message ID generation.
//
// These tests MUST fail on the old index-based code (`${convId.slice(0,8)}-${i}`)
// and pass on the new deterministic mapper. They exercise:
//   1. Idempotency: same input → same IDs on both calls (no random/index drift).
//   2. Tool ID derivation: tool rows use `tool-${toolId}`.
//   3. Collision suffix: two messages with the same role+timestamp get unique IDs
//      by appending `#1`, `#2`, … on repeats.
//   4. toolId is forwarded onto the Message object (required by reconcileActivity
//      tool-id dedup and stable tool-group React keys).
import { describe, it, expect } from 'vitest'
import { mapConversationMessages } from '../agent-conversation-mapper'
import type { RawSessionMessage } from '../agent-conversation-mapper'

describe('mapConversationMessages — stable IDs', () => {
  it('produces identical IDs on two calls with the same input (idempotency)', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'assistant', content: 'hi', timestamp: 2000 },
      { role: 'tool', content: '', toolName: 'Read', toolId: 'toolu_01ABC', timestamp: 3000 },
    ]

    const first = mapConversationMessages(raw).map((m) => m.id)
    const second = mapConversationMessages(raw).map((m) => m.id)

    // Must be identical — would fail on old `${convId.slice(0,8)}-${i}` if convId
    // changed between calls, or on any index-based scheme applied inconsistently.
    expect(first).toEqual(second)
  })

  it('tool rows use tool-${toolId}, not an index-based id', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'do it', timestamp: 1000 },
      { role: 'tool', content: '', toolName: 'Bash', toolId: 'toolu_XYZ999', timestamp: 2000 },
    ]

    const msgs = mapConversationMessages(raw)
    const toolMsg = msgs.find((m) => m.role === 'tool')

    expect(toolMsg?.id).toBe('tool-toolu_XYZ999')
    // Must NOT match the old index pattern
    expect(toolMsg?.id).not.toMatch(/^[0-9a-f]+-\d+$/)
  })

  it('toolId is forwarded onto the mapped Message object', () => {
    const raw: RawSessionMessage[] = [
      { role: 'tool', content: 'output', toolName: 'Read', toolId: 'toolu_FORWARD', timestamp: 5000 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].toolId).toBe('toolu_FORWARD')
  })

  it('non-tool rows use role-timestamp as base id', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'q', timestamp: 1234 },
      { role: 'assistant', content: 'a', timestamp: 5678 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].id).toBe('user-1234')
    expect(msgs[1].id).toBe('assistant-5678')
  })

  it('collision suffix makes same-role/same-timestamp rows unique', () => {
    // Two assistant messages at the same millisecond (can happen during streaming
    // when timestamps are coarse). The first keeps the plain key; subsequent ones
    // get #1, #2, … suffixes.
    const raw: RawSessionMessage[] = [
      { role: 'assistant', content: 'part A', timestamp: 9000 },
      { role: 'assistant', content: 'part B', timestamp: 9000 },
      { role: 'assistant', content: 'part C', timestamp: 9000 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].id).toBe('assistant-9000')
    expect(msgs[1].id).toBe('assistant-9000#1')
    expect(msgs[2].id).toBe('assistant-9000#2')

    // All IDs are unique
    const ids = msgs.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('collision suffix is stable across calls (idempotent)', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'a', timestamp: 100 },
      { role: 'user', content: 'b', timestamp: 100 },
    ]

    const first = mapConversationMessages(raw).map((m) => m.id)
    const second = mapConversationMessages(raw).map((m) => m.id)

    expect(first).toEqual(['user-100', 'user-100#1'])
    expect(second).toEqual(['user-100', 'user-100#1'])
  })

  it('appending a message at the tail does not change earlier ids', () => {
    const base: RawSessionMessage[] = [
      { role: 'user', content: 'q', timestamp: 1000 },
      { role: 'assistant', content: 'a', timestamp: 2000 },
    ]
    const extended: RawSessionMessage[] = [
      ...base,
      { role: 'tool', content: '', toolName: 'Bash', toolId: 'toolu_NEW', timestamp: 3000 },
    ]

    const baseMapped = mapConversationMessages(base)
    const extMapped = mapConversationMessages(extended)

    // IDs for the first two messages must be identical in both results
    expect(extMapped[0].id).toBe(baseMapped[0].id)
    expect(extMapped[1].id).toBe(baseMapped[1].id)
    // New tail message has the expected tool id
    expect(extMapped[2].id).toBe('tool-toolu_NEW')
  })

  it('empty input returns empty array', () => {
    expect(mapConversationMessages([])).toEqual([])
  })
})
