/**
 * sessionStore — markAllResourcesRead action ("Clear all")
 *
 * Pins the notifications-panel "Clear all" behavior end to end at the store
 * boundary:
 *   - every passed item id lands in readResourceIds (local optimistic update)
 *   - window.ion.markResourceRead is invoked once per item with (kind, id) so
 *     the read state fans out through the engine to other subscribers (iOS)
 *   - already-read state is preserved
 *
 * The per-item fan-out is the regression that would silently break if the
 * action were reduced to a local-only state update (the bug the
 * cross-device contract is meant to prevent: desktop clears, iOS stays unread).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// session-store-helpers.ts calls `new Audio(...)` at module load; stub it.
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'mock-tab',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle' as const,
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    customTitle: null,
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: 'auto' as const,
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
    lastMessagePreview: null,
  })),
  initialModelOverride: vi.fn(() => null),
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
  isTextFile: vi.fn(() => true),
  editorDirForTab: vi.fn(() => ''),
}))

// TerminalPanel touches xterm at module load.
vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../../components/TerminalInstance', () => ({
  serializeTerminalBuffer: vi.fn(() => ''),
}))

// session-store-persistence wires IPC listeners at module load; no-op them.
vi.mock('../session-store-persistence', () => ({
  setupPersistence: vi.fn(),
}))

// preferences.ts reads localStorage at module load; stub the store.
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      preferredModel: null,
      engineDefaultModel: null,
      excludedResourceKinds: [],
    })),
  },
}))

const { mockMarkResourceRead } = vi.hoisted(() => {
  const fn = vi.fn()
  ;(globalThis as any).window = {
    ion: { markResourceRead: fn },
    crypto: { randomUUID: () => 'uuid-1234' },
  }
  return { mockMarkResourceRead: fn }
})

import { useSessionStore } from '../sessionStore'
import type { ResourceItem } from '../../../shared/types-engine'

function makeItem(id: string, kind = 'briefing'): ResourceItem {
  return {
    id,
    kind,
    content: 'body',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('markAllResourcesRead', () => {
  beforeEach(() => {
    mockMarkResourceRead.mockClear()
    useSessionStore.setState({ readResourceIds: new Set<string>() })
  })

  it('marks every passed item as read locally', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')]
    useSessionStore.getState().markAllResourcesRead(items)
    const read = useSessionStore.getState().readResourceIds
    expect(read.has('a')).toBe(true)
    expect(read.has('b')).toBe(true)
    expect(read.has('c')).toBe(true)
  })

  it('fans out to the engine once per item with (kind, id)', () => {
    const items = [makeItem('a', 'briefing'), makeItem('b', 'alert')]
    useSessionStore.getState().markAllResourcesRead(items)
    expect(mockMarkResourceRead).toHaveBeenCalledTimes(2)
    expect(mockMarkResourceRead).toHaveBeenCalledWith('briefing', 'a')
    expect(mockMarkResourceRead).toHaveBeenCalledWith('alert', 'b')
  })

  it('preserves already-read ids', () => {
    useSessionStore.setState({ readResourceIds: new Set(['existing']) })
    useSessionStore.getState().markAllResourcesRead([makeItem('new-1')])
    const read = useSessionStore.getState().readResourceIds
    expect(read.has('existing')).toBe(true)
    expect(read.has('new-1')).toBe(true)
  })

  it('is a no-op for an empty list (no engine calls)', () => {
    useSessionStore.getState().markAllResourcesRead([])
    expect(mockMarkResourceRead).not.toHaveBeenCalled()
  })
})
