/**
 * Cache/fallback tests for getRemoteTabStates — the read side of the
 * renderer-push snapshot architecture.
 *
 * Pins:
 *   - fresh cache (< RENDERER_CACHE_MAX_AGE_MS) → served WITHOUT invoking the
 *     legacy renderer poll
 *   - empty cache → legacy poll invoked; a non-empty result REFRESHES the cache
 *   - stale cache (>= max age) → legacy poll invoked
 *   - legacy poll returning empty does NOT poison the cache and falls through
 *     to the cold-start path
 *   - the shared cached manifest object is never mutated by the main-process
 *     read-state overlay (copy-on-write)
 *
 * The legacy poll is injected via _setPollRendererTabStatesForTest so no
 * BrowserWindow / executeJavaScript is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockIsResourceRead, mockGetHealth } = vi.hoisted(() => ({
  mockIsResourceRead: vi.fn((_id: string) => false),
  mockGetHealth: vi.fn((): { tabs: Array<{ tabId: string; status: string; conversationId: string | null; lastActivityAt?: number }> } => ({ tabs: [] })),
}))

vi.mock('../../state', () => ({
  state: {
    mainWindow: null,
    remoteTransport: null,
    rendererSnapshotCache: null,
  },
  sessionPlane: { getHealth: mockGetHealth },
  lastMessagePreview: new Map<string, string>(),
}))

vi.mock('../../settings-store', () => ({
  TABS_FILE: '/nonexistent/for-tests/tabs.json',
}))

vi.mock('../../event-wiring-resources', () => ({
  isResourceRead: (id: string) => mockIsResourceRead(id),
}))

import { getRemoteTabStates, RENDERER_CACHE_MAX_AGE_MS, _setPollRendererTabStatesForTest } from '../snapshot'
import { state } from '../../state'
import type { RemoteTabStatesPayload, ProjectedRendererTab } from '../../../shared/remote-projection-types'

function projectedTab(id: string, overrides: Partial<ProjectedRendererTab> = {}): ProjectedRendererTab {
  return {
    id,
    title: `Tab ${id}`,
    customTitle: null,
    status: 'idle',
    workingDirectory: '/p',
    permissionMode: 'auto',
    permissionQueue: [],
    elicitationQueue: [],
    contextTokens: null,
    contextWindow: null,
    messageCount: 0,
    queuedPrompts: [],
    engineProfileId: null,
    groupId: null,
    modelOverride: null,
    groupPinned: false,
    conversationId: null,
    lastMessageContent: null,
    lastActivityTs: 0,
    convFingerprint: '',
    pillColor: null,
    pillIcon: null,
    ...overrides,
  }
}

describe('getRemoteTabStates — renderer-push cache + legacy-poll fallback', () => {
  let pollMock: ReturnType<typeof vi.fn<() => Promise<RemoteTabStatesPayload>>>

  beforeEach(() => {
    pollMock = vi.fn(async (): Promise<RemoteTabStatesPayload> => ({ tabs: [], resourceManifest: {} }))
    _setPollRendererTabStatesForTest(pollMock)
    state.rendererSnapshotCache = null
    mockIsResourceRead.mockReturnValue(false)
    mockGetHealth.mockReturnValue({ tabs: [] })
  })

  afterEach(() => {
    _setPollRendererTabStatesForTest(null)
    state.rendererSnapshotCache = null
    vi.restoreAllMocks()
  })

  it('serves a fresh cache without invoking the legacy poll', async () => {
    state.rendererSnapshotCache = {
      tabs: [projectedTab('t1')],
      resourceManifest: {},
      receivedAt: Date.now(),
    }
    const { tabs } = await getRemoteTabStates()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('t1')
    expect(pollMock).not.toHaveBeenCalled()
  })

  it('runs the legacy poll when the cache is empty, and refreshes the cache from its result', async () => {
    pollMock.mockResolvedValue({ tabs: [projectedTab('t-polled')], resourceManifest: {} })
    const { tabs } = await getRemoteTabStates()
    expect(pollMock).toHaveBeenCalledTimes(1)
    expect(tabs[0].id).toBe('t-polled')
    // Cache refreshed → the next call is a cache read, no second poll.
    const second = await getRemoteTabStates()
    expect(pollMock).toHaveBeenCalledTimes(1)
    expect(second.tabs[0].id).toBe('t-polled')
  })

  it('runs the legacy poll when the cache is stale (>= max age)', async () => {
    state.rendererSnapshotCache = {
      tabs: [projectedTab('t-stale')],
      resourceManifest: {},
      receivedAt: Date.now() - RENDERER_CACHE_MAX_AGE_MS - 1,
    }
    pollMock.mockResolvedValue({ tabs: [projectedTab('t-fresh')], resourceManifest: {} })
    const { tabs } = await getRemoteTabStates()
    expect(pollMock).toHaveBeenCalledTimes(1)
    expect(tabs[0].id).toBe('t-fresh')
  })

  it('does not cache an empty poll result and falls through to the cold-start path', async () => {
    mockGetHealth.mockReturnValue({
      tabs: [{ tabId: 'health-1', status: 'idle', conversationId: null, lastActivityAt: 123 }],
    })
    const { tabs } = await getRemoteTabStates()
    expect(pollMock).toHaveBeenCalledTimes(1)
    // Cold-start path served from engine health.
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('health-1')
    // Empty result must NOT be cached (a cached empty would mask the renderer
    // coming online for the whole freshness window).
    expect(state.rendererSnapshotCache).toBeNull()
  })

  it('maps cached projected tabs through the wire projection (sorted running-first)', async () => {
    state.rendererSnapshotCache = {
      tabs: [
        projectedTab('t-idle', { lastActivityTs: 500 }),
        projectedTab('t-run', { status: 'running', lastActivityTs: 100 }),
      ],
      resourceManifest: {},
      receivedAt: Date.now(),
    }
    const { tabs } = await getRemoteTabStates()
    // Running tabs sort first regardless of lastActivityAt.
    expect(tabs.map((t) => t.id)).toEqual(['t-run', 't-idle'])
    expect(tabs[0].status).toBe('running')
    // lastActivityTs → lastActivityAt wire rename survived.
    expect(tabs[1].lastActivityAt).toBe(500)
  })

  it('overlays main-process persisted read state WITHOUT mutating the cached manifest (copy-on-write)', async () => {
    const cachedManifest = {
      briefing: [{ id: 'r1', kind: 'briefing', title: 'B', createdAt: '2025-01-01', read: false }],
    }
    state.rendererSnapshotCache = {
      tabs: [projectedTab('t1')],
      resourceManifest: cachedManifest,
      receivedAt: Date.now(),
    }
    mockIsResourceRead.mockImplementation((id: string) => id === 'r1')
    const { resourceManifest } = await getRemoteTabStates()
    // Served manifest carries the persisted read state…
    expect(resourceManifest.briefing[0].read).toBe(true)
    // …but the cached object is untouched (a mutated cache would leak
    // main-only read state into renderer-push fingerprint comparisons).
    expect(cachedManifest.briefing[0].read).toBe(false)
  })
})
