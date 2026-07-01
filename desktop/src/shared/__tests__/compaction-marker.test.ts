import { describe, it, expect } from 'vitest'
import { buildCompactionMarkerContent, COMPACTION_MARKER_PREFIX } from '../compaction-marker'

describe('buildCompactionMarkerContent', () => {
  it('omits "N → N messages" and shows blocks cleared on a micro-only pass', () => {
    // Micro-only: engine flagged microOnly, no messages dropped, blocks cleared.
    const content = buildCompactionMarkerContent({
      strategy: 'auto',
      messagesBefore: 12,
      messagesAfter: 12,
      clearedBlocks: 4,
      microOnly: true,
    })
    expect(content).not.toBeNull()
    expect(content).toContain(COMPACTION_MARKER_PREFIX)
    expect(content).toContain('4 blocks cleared')
    // The misleading "N → N messages" segment must NOT appear.
    expect(content).not.toContain('12 → 12')
    expect(content).not.toContain('messages')
  })

  it('treats "no messages dropped" as micro-only even without the flag', () => {
    // Defensive: an engine that predates the microOnly field but dropped no
    // messages must still not render "N → N".
    const content = buildCompactionMarkerContent({
      strategy: 'auto',
      messagesBefore: 20,
      messagesAfter: 20,
      clearedBlocks: 2,
    })
    expect(content).toContain('2 blocks cleared')
    expect(content).not.toContain('20 → 20')
  })

  it('shows "N → M messages" when messages were actually dropped', () => {
    const content = buildCompactionMarkerContent({
      strategy: 'auto',
      messagesBefore: 40,
      messagesAfter: 10,
      clearedBlocks: 3,
      summary: '## Decisions\nUse SQLite.',
    })
    expect(content).toContain('40 → 10 messages')
    expect(content).toContain('3 blocks cleared')
    expect(content).toContain('## Decisions')
  })

  it('returns null for a pure no-op (nothing cleared, nothing dropped, no summary)', () => {
    const content = buildCompactionMarkerContent({
      strategy: 'auto',
      messagesBefore: 5,
      messagesAfter: 5,
      clearedBlocks: 0,
    })
    expect(content).toBeNull()
  })

  it('renders a marker for a summary-only event even with no dropped messages', () => {
    const content = buildCompactionMarkerContent({
      strategy: 'reactive',
      messagesBefore: 8,
      messagesAfter: 8,
      clearedBlocks: 0,
      summary: '## Files\nfoo.go',
    })
    expect(content).not.toBeNull()
    expect(content).toContain('## Files')
    // Still micro-only: no "N → N" segment.
    expect(content).not.toContain('8 → 8')
  })
})
