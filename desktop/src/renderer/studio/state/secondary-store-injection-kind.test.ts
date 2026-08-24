// @vitest-environment jsdom
/**
 * The Studio mirror must carry a turn's authorship classification.
 *
 * ── The failure class ───────────────────────────────────────────────────────
 *
 * The mirror does not read the owner's store. It REBUILDS each `Message` from
 * a payload the main process sends — `StudioUserMessageEcho` for a live turn,
 * `StudioHistoryReplace` for a reload. So any field absent from those payloads
 * is silently absent from the Studio transcript, and the two presentations
 * disagree with nothing failing.
 *
 * That is exactly how a Guided Questions submission rendered as an ordinary
 * user bubble in Studio while the Overlay framed it correctly: the field was
 * right in the store, right on disk, and right in the Overlay — and simply not
 * in the mirror payload.
 *
 * These tests pin the transfer for both payloads, so the next field added to a
 * user turn fails here rather than in a screenshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
}))
vi.mock('../../lib/window-role', () => ({ isMirrorWindow: () => true, windowRole: () => 'studio' }))

import { useSessionStore } from '../../stores/sessionStore'
import { applyUserMessageEcho, applyHistoryReplace } from './secondary-store'

/** Seed one mirrored tab with a single 'main' instance. */
function seedTab(tabId: string): void {
  useSessionStore.setState({
    tabs: [{ id: tabId }] as never,
    conversationPanes: new Map([[tabId, {
      activeInstanceId: 'main',
      instances: [{ id: 'main', messages: [], messageCount: 0 }],
    }]]) as never,
  })
}

function messagesOf(tabId: string): Array<{ injectionKind?: string }> {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  return (pane?.instances.find((i) => i.id === 'main')?.messages ?? []) as never
}

beforeEach(() => {
  seedTab('tab-1')
})

describe('Studio mirror — live user-turn echo', () => {
  it('carries injectionKind so a submission keeps its frame', () => {
    applyUserMessageEcho('tab-1', {
      id: 'req-1',
      content: 'My answers to "Scope": ...',
      timestamp: 1,
      injectionKind: 'structured_answer',
    })

    expect(messagesOf('tab-1')[0]?.injectionKind).toBe('structured_answer')
  })

  it('leaves an ordinary turn unclassified', () => {
    applyUserMessageEcho('tab-1', { id: 'req-2', content: 'a turn I typed', timestamp: 1 })

    expect(messagesOf('tab-1')[0]?.injectionKind).toBeUndefined()
  })
})

describe('Studio mirror — history replace', () => {
  it('carries injectionKind so the frame survives a reload', () => {
    // The reload path is the one the operator actually hit: the submission had
    // been made in an earlier session, and the mirror rebuilt the transcript
    // from this payload.
    applyHistoryReplace({
      tabId: 'tab-1',
      instanceId: 'main',
      messages: [
        { id: 'm1', role: 'user', content: 'My answers...', timestamp: 1, injectionKind: 'structured_answer' },
        { id: 'm2', role: 'user', content: 'a turn I typed', timestamp: 2 },
      ],
    })

    const msgs = messagesOf('tab-1')
    expect(msgs[0]?.injectionKind).toBe('structured_answer')
    expect(msgs[1]?.injectionKind).toBeUndefined()
  })
})
