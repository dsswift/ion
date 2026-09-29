import { describe, expect, it } from 'vitest'
import {
  buildCompactionMarkerContent,
  buildNativeCompactionMarkerContent,
  COMPACTION_MARKER_PREFIX,
} from '../compaction-marker'
import { buildMarkerContent } from '../session-message-mapper'
import type { SessionLoadMessage } from '../types-session'

// A delegated CLI compacting its own session removes nothing from Ion's
// transcript, so every message-count field is zero. The generic builder treats
// that as a no-op and returns null, which would silently swallow the marker —
// the user would see the assistant's recollection change with no explanation.
describe('native compaction marker', () => {
  it('renders instead of collapsing to a no-op', () => {
    const content = buildCompactionMarkerContent({ strategy: 'native', trigger: 'auto', preTokens: 841821 })
    expect(content).not.toBeNull()
    expect(content).toContain(COMPACTION_MARKER_PREFIX)
  })

  it('says the assistant compacted its own context, not that history was lost', () => {
    const content = buildNativeCompactionMarkerContent({ strategy: 'native', trigger: 'auto', preTokens: 841821 })
    expect(content).toContain('its own context')
    // Never an "N → M messages" figure: no messages left this conversation.
    expect(content).not.toContain('messages')
    expect(content).toContain('842K')
  })

  it('marks a user-requested compaction as requested', () => {
    expect(buildNativeCompactionMarkerContent({ strategy: 'native', trigger: 'manual' })).toContain('requested')
    expect(buildNativeCompactionMarkerContent({ strategy: 'native', trigger: 'auto' })).not.toContain('requested')
  })

  it('omits the token figure when the provider reported none', () => {
    expect(buildNativeCompactionMarkerContent({ strategy: 'native' })).toBe(
      `${COMPACTION_MARKER_PREFIX} · the assistant compacted its own context`,
    )
  })

  // History replay: the persisted marker row carries strategy/trigger/preTokens
  // and must reach the same builder, or a reloaded conversation loses the row.
  it('survives history reload through the marker mapper', () => {
    const row = {
      id: 'e1',
      role: 'system',
      content: '[Compaction]',
      timestamp: Date.now(),
      markerKind: 'compaction',
      markerStrategy: 'native',
      markerTrigger: 'auto',
      markerPreTokens: 841821,
    } as unknown as SessionLoadMessage
    const content = buildMarkerContent(row)
    expect(content).not.toBeNull()
    expect(content).toContain('its own context')
    expect(content).toContain('842K')
  })

  // The engine's own compaction must be unaffected.
  it('leaves engine compactions on the original builder', () => {
    const content = buildCompactionMarkerContent({ strategy: 'full', messagesBefore: 40, messagesAfter: 8 })
    expect(content).toContain('40 → 8 messages')
    expect(content).not.toContain('its own context')
  })
})
