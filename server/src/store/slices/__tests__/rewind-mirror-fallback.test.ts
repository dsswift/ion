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

// session-store-helpers.ts imports a binary asset (notification.mp3) that
// resolves fine under the desktop's Vite config but not here; stub makeLocalTab
// with the shape the real helper produces so this test's tab fixture stays
// representative without pulling in the asset pipeline.
vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'local-id',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: 'auto',
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
  })),
  isReusableBlankConversationTab: vi.fn(() => false),
  initialModelOverride: vi.fn(() => null),
  initialPermissionMode: vi.fn(() => 'auto'),
  initialThinkingEffort: vi.fn(() => 'off'),
  nextMsgId: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 8)}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
}))

const engineRewindMock = vi.fn().mockResolvedValue({ ok: true })
const engineBroadcastHistoryMock = vi.fn().mockResolvedValue(undefined)

// The real sessionStore composes every slice, so host-api is mocked with
// importOriginal to keep every other function real; only the two calls this
// rewind path makes (engineRewind, engineBroadcastHistory) are overridden —
// they used to be window.ion.* (Electron preload bridge) but now delegate to
// the real engineBridge/sessionPlane, which this jsdom test has no engine for.
vi.mock('../../host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../host-api')>()
  return {
    ...actual,
    engineRewind: (...args: any[]) => engineRewindMock(...args),
    engineBroadcastHistory: (...args: any[]) => engineBroadcastHistoryMock(...args),
  }
})

import { useSessionStore } from '../../sessionStore'
import { makeLocalTab } from '../../session-store-helpers'
import type { Message } from '@ion/shared/types'

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 } as Message
}

beforeEach(() => {
  engineRewindMock.mockClear()
  ;(window as unknown as { ion: unknown }).ion = {
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
