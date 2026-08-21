// @vitest-environment jsdom
/**
 * Rewind from the Studio mirror (regression): message ids are WINDOW-LOCAL
 * (the mirror hydrates canonical hex ids from history; the owner holds
 * optimistic msg-N ids for anything it minted locally), so a forwarded
 * rewind's id NEVER matches the owner's store when the mirror's copy of a
 * row predates any owner-side re-key. The user-turn ordinal is the
 * identity-free fallback both windows agree on. Before the fix, the owner
 * logged "rewind: message not found" and nothing rewound.
 *
 * rewindEngineInstance is transactional and async — every assertion here
 * awaits it before reading the resulting store state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSessionStore } from '../../sessionStore'
import { makeLocalTab } from '../../session-store-helpers'
import type { Message } from '../../../../shared/types'

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 } as Message
}

const engineRewindMock = vi.fn().mockResolvedValue({ ok: true })
const engineBroadcastHistoryMock = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  engineRewindMock.mockClear()
  ;(window as unknown as { ion: unknown }).ion = {
    engineRewind: engineRewindMock,
    engineBroadcastHistory: engineBroadcastHistoryMock,
    saveTabs: vi.fn().mockResolvedValue(undefined),
    saveTabContent: vi.fn().mockResolvedValue(undefined),
  }
  const tab = { ...makeLocalTab(), id: 'tab-1', status: 'idle' as const }
  // Durable (engine-issued, non-`msg-`) ids — represents a mirror hydrated
  // from history or re-keyed by a prior confirmation, exactly like the
  // owner's own store once the engine has confirmed a turn.
  const messages = [
    msg('owner-1', 'user', 'first prompt'),
    msg('owner-2', 'assistant', 'first answer'),
    msg('owner-3', 'user', 'second prompt'),
    msg('owner-4', 'assistant', 'second answer'),
  ]
  useSessionStore.setState({
    rehydrating: true, // gate persistence (synthetic fixtures)
    tabs: [tab],
    activeTabId: 'tab-1',
    conversationPanes: new Map([
      [
        'tab-1',
        {
          activeInstanceId: 'main',
          instances: [{ id: 'main', messages, messageCount: messages.length, permissionQueue: [], elicitationQueue: [] }],
        } as never,
      ],
    ]),
  })
})

describe('rewindEngineInstance mirror-id fallback', () => {
  it('unknown id + ordinal → resolves the Nth user turn (the forwarded-from-mirror case)', async () => {
    // 'mirror-8hex' was minted in the Studio window; the owner never saw it.
    const result = await useSessionStore.getState().rewindEngineInstance('tab-1', 'main', 'mirror-8hex', 1)
    expect(result.ok).toBe(true)
    const inst = useSessionStore.getState().conversationPanes.get('tab-1')!.instances[0]
    // Rewound to BEFORE the second user turn: only the first pair remains.
    expect(inst.messages.map((m) => m.id)).toEqual(['owner-1', 'owner-2'])
    // The resolved row (owner-3) carries a durable engine entry id, so the
    // exact-entry address is sent even though resolution went via the
    // ordinal fallback.
    expect(engineRewindMock).toHaveBeenCalledWith('tab-1', { entryId: 'owner-3' })
  })

  it('unknown id with NO ordinal still refuses (no guessing)', async () => {
    const result = await useSessionStore.getState().rewindEngineInstance('tab-1', 'main', 'mirror-8hex')
    expect(result.ok).toBe(false)
    const inst = useSessionStore.getState().conversationPanes.get('tab-1')!.instances[0]
    expect(inst.messages).toHaveLength(4)
    expect(engineRewindMock).not.toHaveBeenCalled()
  })

  it('id match still wins when present (owner-window path unchanged)', async () => {
    const result = await useSessionStore.getState().rewindEngineInstance('tab-1', 'main', 'owner-3')
    expect(result.ok).toBe(true)
    const inst = useSessionStore.getState().conversationPanes.get('tab-1')!.instances[0]
    expect(inst.messages.map((m) => m.id)).toEqual(['owner-1', 'owner-2'])
    expect(engineRewindMock).toHaveBeenCalledWith('tab-1', { entryId: 'owner-3' })
  })
})
