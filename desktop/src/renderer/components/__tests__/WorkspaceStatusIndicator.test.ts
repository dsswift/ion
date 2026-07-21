/**
 * Tests for WorkspaceStatusIndicator exported functions:
 *
 *   globalRunningTier  — two-tier global running-state derivation for the workspace dot.
 *   computeStatusCounts — per-bucket count for the popover breakdown.
 *
 * Both are pure folding functions exported from WorkspaceStatusIndicator.tsx.
 *
 * Cascade order pinned by computeStatusCounts tests:
 *   dead/failed → dead
 *   running     → running
 *   connecting  → connecting
 *   waitingChildren → waitingChildren
 *   permissionQueue non-empty OR waitingState === 'question' → questions
 *   waitingState === 'plan-ready' → planReady
 *   bashExecuting → bash
 *   hasUnread   → unread
 *   else        → idle
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ─── Stubs ────────────────────────────────────────────────────────────────────

// Control which tab IDs have running children via this settable set.
const runningChildrenIds = new Set<string>()

// Control getWaitingState return value per tab ID.
const waitingStateMap = new Map<string, 'plan-ready' | 'question' | null>()

// Control permissionQueue length per tab ID.
const permissionQueueMap = new Map<string, number>()

vi.mock('../TabStripShared', () => ({
  anyEngineInstanceHasRunningChildren: (tabId: string) => runningChildrenIds.has(tabId),
  getWaitingState: (tab: any) => waitingStateMap.get(tab.id) ?? null,
}))

vi.mock('../../stores/conversation-instance', () => ({
  activeInstance: (_panes: any, tabId: string) => {
    const qLen = permissionQueueMap.get(tabId) ?? 0
    return { permissionQueue: new Array(qLen) }
  },
}))

vi.mock('@phosphor-icons/react', () => ({}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }) },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1 }) },
}))

import { globalRunningTier, computeStatusCounts } from '../WorkspaceStatusIndicator'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTab(id: string, status: string, overrides: Record<string, unknown> = {}): any {
  return { id, status, title: id, customTitle: null, isTerminalOnly: false, bashExecuting: false, hasUnread: false, ...overrides }
}

// ─── globalRunningTier tests ──────────────────────────────────────────────────

describe('WorkspaceStatusIndicator.globalRunningTier', () => {
  afterEach(() => { runningChildrenIds.clear() })

  it('returns idle for an empty tab list', () => {
    expect(globalRunningTier([])).toBe('idle')
  })

  it('returns idle when all tabs are idle', () => {
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'completed')]
    expect(globalRunningTier(tabs)).toBe('idle')
  })

  it('returns running when any tab status is running', () => {
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'running')]
    expect(globalRunningTier(tabs)).toBe('running')
  })

  it('returns running when any tab status is connecting', () => {
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'connecting')]
    expect(globalRunningTier(tabs)).toBe('running')
  })

  it('running wins over waiting children (foreground beats background)', () => {
    runningChildrenIds.add('t1')
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'running')]
    expect(globalRunningTier(tabs)).toBe('running')
  })

  it('returns waiting when any tab has running children and none are foreground', () => {
    runningChildrenIds.add('t1')
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'idle')]
    expect(globalRunningTier(tabs)).toBe('waiting')
  })

  it('returns idle when hasRunningChildren is false for all tabs', () => {
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'completed')]
    expect(globalRunningTier(tabs)).toBe('idle')
  })

  it('returns idle when dead/failed tabs are present but nothing running', () => {
    const tabs = [makeTab('t1', 'dead'), makeTab('t2', 'failed'), makeTab('t3', 'idle')]
    expect(globalRunningTier(tabs)).toBe('idle')
  })

  it('returns running for first running tab in multi-tab workspace', () => {
    const tabs = [
      makeTab('t1', 'idle'), makeTab('t2', 'idle'), makeTab('t3', 'running'),
    ]
    expect(globalRunningTier(tabs)).toBe('running')
  })
})

// ─── computeStatusCounts tests ───────────────────────────────────────────────

describe('WorkspaceStatusIndicator.computeStatusCounts', () => {
  afterEach(() => {
    runningChildrenIds.clear()
    waitingStateMap.clear()
    permissionQueueMap.clear()
  })

  it('all zeros for an empty tab list', () => {
    const c = computeStatusCounts([])
    expect(c).toMatchObject({ running: 0, connecting: 0, waitingChildren: 0, questions: 0, planReady: 0, bash: 0, unread: 0, idle: 0, dead: 0 })
  })

  it('idle tab lands in idle bucket', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.idle).toBe(1)
    expect(c.planReady).toBe(0)
    expect(c.questions).toBe(0)
  })

  it('running tab lands in running bucket', () => {
    const c = computeStatusCounts([makeTab('t1', 'running')])
    expect(c.running).toBe(1)
    expect(c.idle).toBe(0)
  })

  it('connecting tab lands in connecting bucket', () => {
    const c = computeStatusCounts([makeTab('t1', 'connecting')])
    expect(c.connecting).toBe(1)
    expect(c.idle).toBe(0)
  })

  it('dead and failed tabs land in dead bucket', () => {
    const c = computeStatusCounts([makeTab('t1', 'dead'), makeTab('t2', 'failed')])
    expect(c.dead).toBe(2)
    expect(c.idle).toBe(0)
  })

  it('tab with running children lands in waitingChildren bucket', () => {
    runningChildrenIds.add('t1')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.waitingChildren).toBe(1)
    expect(c.idle).toBe(0)
  })

  // ── planReady ───────────────────────────────────────────────────────────

  it('plan-ready tab is counted in planReady, not idle', () => {
    waitingStateMap.set('t1', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.planReady).toBe(1)
    expect(c.idle).toBe(0)
    expect(c.questions).toBe(0)
  })

  it('plan-ready outranks bash', () => {
    waitingStateMap.set('t1', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle', { bashExecuting: true })])
    expect(c.planReady).toBe(1)
    expect(c.bash).toBe(0)
  })

  it('plan-ready outranks unread', () => {
    waitingStateMap.set('t1', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle', { hasUnread: true })])
    expect(c.planReady).toBe(1)
    expect(c.unread).toBe(0)
  })

  // ── questions ────────────────────────────────────────────────────────────

  it('question-waiting tab is counted in questions, not idle', () => {
    waitingStateMap.set('t1', 'question')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.questions).toBe(1)
    expect(c.idle).toBe(0)
    expect(c.planReady).toBe(0)
  })

  it('permission-queued tab is counted in questions', () => {
    permissionQueueMap.set('t1', 2)
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.questions).toBe(1)
    expect(c.idle).toBe(0)
  })

  it('permission-queued tab is counted in questions even when waitingState is null', () => {
    permissionQueueMap.set('t1', 1)
    // waitingStateMap has no entry for t1 → returns null
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.questions).toBe(1)
    expect(c.planReady).toBe(0)
  })

  it('questions outranks planReady (question wins when both could fire)', () => {
    // permissionQueue present AND waitingState plan-ready — queue wins (questions)
    permissionQueueMap.set('t1', 1)
    waitingStateMap.set('t1', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.questions).toBe(1)
    expect(c.planReady).toBe(0)
  })

  it('questions outranks bash', () => {
    waitingStateMap.set('t1', 'question')
    const c = computeStatusCounts([makeTab('t1', 'idle', { bashExecuting: true })])
    expect(c.questions).toBe(1)
    expect(c.bash).toBe(0)
  })

  // ── cascade ordering across all buckets ──────────────────────────────────

  it('bash tab lands in bash bucket when no higher-priority state applies', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle', { bashExecuting: true })])
    expect(c.bash).toBe(1)
    expect(c.idle).toBe(0)
  })

  it('unread tab lands in unread bucket when no higher-priority state applies', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle', { hasUnread: true })])
    expect(c.unread).toBe(1)
    expect(c.idle).toBe(0)
  })

  it('terminal-only tabs are excluded from all counts', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle', { isTerminalOnly: true })])
    expect(c.idle).toBe(0)
  })

  it('mixed workspace distributes tabs to correct buckets', () => {
    runningChildrenIds.add('t3')
    waitingStateMap.set('t4', 'plan-ready')
    waitingStateMap.set('t5', 'question')
    permissionQueueMap.set('t6', 1)
    const tabs = [
      makeTab('t1', 'running'),
      makeTab('t2', 'idle'),
      makeTab('t3', 'idle'),
      makeTab('t4', 'idle'),
      makeTab('t5', 'idle'),
      makeTab('t6', 'idle'),
      makeTab('t7', 'idle', { bashExecuting: true }),
      makeTab('t8', 'idle', { hasUnread: true }),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.running).toBe(1)
    expect(c.waitingChildren).toBe(1)
    expect(c.planReady).toBe(1)
    expect(c.questions).toBe(2) // t5 (question) + t6 (permission queue)
    expect(c.bash).toBe(1)
    expect(c.unread).toBe(1)
    expect(c.idle).toBe(1) // t2 only
  })

  // ── name lists for active-work buckets ────────────────────────────────────

  it('runningTabs collects running AND connecting tabs, in order', () => {
    const tabs = [
      makeTab('t1', 'running'),
      makeTab('t2', 'idle'),
      makeTab('t3', 'connecting'),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs.map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('waitingTabs collects only tabs with running children', () => {
    runningChildrenIds.add('t2')
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'idle'), makeTab('t3', 'idle')]
    const c = computeStatusCounts(tabs)
    expect(c.waitingTabs.map((t) => t.id)).toEqual(['t2'])
    expect(c.runningTabs).toEqual([])
  })

  it('idle / question / plan-ready / bash / unread tabs appear in NEITHER name list', () => {
    waitingStateMap.set('t2', 'question')
    waitingStateMap.set('t3', 'plan-ready')
    const tabs = [
      makeTab('t1', 'idle'),
      makeTab('t2', 'idle'),
      makeTab('t3', 'idle'),
      makeTab('t4', 'idle', { bashExecuting: true }),
      makeTab('t5', 'idle', { hasUnread: true }),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs).toEqual([])
    expect(c.waitingTabs).toEqual([])
  })

  it('customTitle wins over title in the name list', () => {
    const tabs = [makeTab('t1', 'running', { title: 'auto-name', customTitle: 'My Tab' })]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs[0]).toEqual({ id: 't1', title: 'My Tab' })
  })

  it('falls back to title when customTitle is null', () => {
    const tabs = [makeTab('t1', 'connecting', { title: 'auto-name', customTitle: null })]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs[0].title).toBe('auto-name')
  })
})
