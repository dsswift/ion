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
 *   unread (R9 derivation: manualUnread || completion > visit) → unread
 *   else        → idle
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ─── Stubs ────────────────────────────────────────────────────────────────────

// Control which tab IDs have running children via this settable set.
const runningChildrenIds = new Set<string>()
const runningShellIds = new Set<string>()

// Control which tab IDs have an executing terminal command via this settable set.
const terminalCommandIds = new Set<string>()
// Control getWaitingState return value per tab ID.
const waitingStateMap = new Map<string, 'plan-ready' | 'question' | null>()

// Control permissionQueue length per tab ID.
const permissionQueueMap = new Map<string, number>()

// Control the tab's permission mode (plan vs auto) per tab ID. Tabs absent
// from the map resolve to 'auto' — mirrors effectivePermissionMode's fallback.
const permissionModeMap = new Map<string, 'plan' | 'auto'>()

vi.mock('../TabStripShared', () => ({
  anyEngineInstanceHasRunningChildren: (tabId: string) => runningChildrenIds.has(tabId),
  anyEngineInstanceHasRunningShells: (tabId: string) => runningShellIds.has(tabId),
  isAnyTerminalCommandRunning: (tabId: string) => terminalCommandIds.has(tabId),
  getWaitingState: (tab: any) => waitingStateMap.get(tab.id) ?? null,
}))

vi.mock('../../stores/conversation-instance', () => ({
  activeInstance: (_panes: any, tabId: string) => {
    const qLen = permissionQueueMap.get(tabId) ?? 0
    return { permissionQueue: new Array(qLen) }
  },
  effectivePermissionMode: (tab: any) => permissionModeMap.get(tab.id) ?? 'auto',
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
  return { id, status, title: id, customTitle: null, isTerminalOnly: false, bashExecuting: false, manualUnread: false, lastMessageAt: null, lastVisitedAt: null, ...overrides }
}

// ─── globalRunningTier tests ──────────────────────────────────────────────────

describe('WorkspaceStatusIndicator.globalRunningTier', () => {
  afterEach(() => { runningChildrenIds.clear(); runningShellIds.clear(); terminalCommandIds.clear() })

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

  it('returns idle when tabs are only connecting', () => {
    expect(globalRunningTier([makeTab('t1', 'connecting')])).toBe('idle')
  })

  it('returns running when a terminal command executes', () => {
    terminalCommandIds.add('terminal-tab')
    expect(globalRunningTier([makeTab('terminal-tab', 'idle', { isTerminalOnly: true })], terminalCommandIds)).toBe('running')
    const counts = computeStatusCounts([makeTab('terminal-tab', 'idle', { isTerminalOnly: true })], terminalCommandIds)
    expect(counts.runningTabs.map((tab) => tab.id)).toEqual(['terminal-tab'])
  })

  it('does not treat an idle terminal prompt as workspace work', () => {
    expect(globalRunningTier([makeTab('terminal-tab', 'idle', { isTerminalOnly: true })])).toBe('idle')
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
    runningShellIds.clear()
    terminalCommandIds.clear()
    waitingStateMap.clear()
    permissionQueueMap.clear()
    permissionModeMap.clear()
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
    const c = computeStatusCounts([makeTab('t1', 'idle', { lastMessageAt: 200, lastVisitedAt: 100 })])
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
    const c = computeStatusCounts([makeTab('t1', 'idle', { lastMessageAt: 200, lastVisitedAt: 100 })])
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
      makeTab('t8', 'idle', { lastMessageAt: 200, lastVisitedAt: 100 }),
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

  it('runningTabs collects ONLY running tabs; connecting has its own list', () => {
    const tabs = [
      makeTab('t1', 'running'),
      makeTab('t2', 'idle'),
      makeTab('t3', 'connecting'),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs.map((t) => t.id)).toEqual(['t1'])
    expect(c.connectingTabs.map((t) => t.id)).toEqual(['t3'])
  })

  it('every non-zero foreground count has the same number of names', () => {
    // The wedge this pins: a Running count rendering with no conversations
    // under it because connecting names were pushed into the running list.
    const tabs = [
      makeTab('t1', 'running'),
      makeTab('t2', 'running'),
      makeTab('t3', 'connecting'),
      makeTab('t4', 'connecting'),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs).toHaveLength(c.running)
    expect(c.connectingTabs).toHaveLength(c.connecting)
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
      makeTab('t5', 'idle', { lastMessageAt: 200, lastVisitedAt: 100 }),
    ]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs).toEqual([])
    expect(c.waitingTabs).toEqual([])
  })

  it('customTitle wins over title in the name list', () => {
    const tabs = [makeTab('t1', 'running', { title: 'auto-name', customTitle: 'My Tab' })]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs[0]).toEqual({ id: 't1', title: 'My Tab', mode: 'auto' })
  })

  it('falls back to title when customTitle is null', () => {
    const tabs = [makeTab('t1', 'connecting', { title: 'auto-name', customTitle: null })]
    const c = computeStatusCounts(tabs)
    expect(c.connectingTabs[0].title).toBe('auto-name')
  })

  // ── name lists for idle-ish (collapsible) buckets ──────────────────────────
  //
  // Every bucket now collects tab identities, pushed in the exact branch that
  // increments its count — list length and count can never drift. These pin
  // each idle-ish bucket's list from both directions (right tabs in, wrong
  // tabs out) plus the shared invariants (customTitle, terminal-only).

  it('questionTabs collects question-waiting and permission-queued tabs, in order', () => {
    waitingStateMap.set('t1', 'question')
    permissionQueueMap.set('t3', 1)
    const tabs = [makeTab('t1', 'idle'), makeTab('t2', 'idle'), makeTab('t3', 'idle')]
    const c = computeStatusCounts(tabs)
    expect(c.questionTabs.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(c.questions).toBe(c.questionTabs.length)
  })

  it('planReadyTabs collects plan-ready tabs', () => {
    waitingStateMap.set('t2', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle'), makeTab('t2', 'idle')])
    expect(c.planReadyTabs.map((t) => t.id)).toEqual(['t2'])
    expect(c.planReady).toBe(c.planReadyTabs.length)
  })

  it('bashTabs collects bash-executing tabs', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle', { bashExecuting: true }), makeTab('t2', 'idle')])
    expect(c.bashTabs.map((t) => t.id)).toEqual(['t1'])
    expect(c.bash).toBe(c.bashTabs.length)
  })

  it('unreadTabs collects unread tabs', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle'), makeTab('t2', 'idle', { lastMessageAt: 200, lastVisitedAt: 100 })])
    expect(c.unreadTabs.map((t) => t.id)).toEqual(['t2'])
    expect(c.unread).toBe(c.unreadTabs.length)
  })

  it('idleTabs collects idle tabs only', () => {
    waitingStateMap.set('t2', 'question')
    const c = computeStatusCounts([makeTab('t1', 'idle'), makeTab('t2', 'idle'), makeTab('t3', 'completed')])
    expect(c.idleTabs.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(c.idle).toBe(c.idleTabs.length)
  })

  it('deadTabs collects dead and failed tabs', () => {
    const c = computeStatusCounts([makeTab('t1', 'dead'), makeTab('t2', 'idle'), makeTab('t3', 'failed')])
    expect(c.deadTabs.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(c.dead).toBe(c.deadTabs.length)
  })

  it('customTitle wins in idle-ish lists too', () => {
    waitingStateMap.set('t1', 'question')
    const c = computeStatusCounts([makeTab('t1', 'idle', { title: 'auto', customTitle: 'Named' })])
    expect(c.questionTabs[0].title).toBe('Named')
  })

  it('terminal-only tabs are excluded from idle-ish lists', () => {
    const c = computeStatusCounts([makeTab('t1', 'idle', { isTerminalOnly: true })])
    expect(c.idleTabs).toEqual([])
  })

  // ── mode resolution (plan vs build) ─────────────────────────────────────────

  it('resolves mode: plan when the active instance is in plan mode', () => {
    permissionModeMap.set('t1', 'plan')
    const c = computeStatusCounts([makeTab('t1', 'running')])
    expect(c.runningTabs[0].mode).toBe('plan')
  })

  it('resolves mode: auto by default (build mode)', () => {
    const c = computeStatusCounts([makeTab('t1', 'running')])
    expect(c.runningTabs[0].mode).toBe('auto')
  })

  it('mode rides refs in idle-ish buckets too', () => {
    permissionModeMap.set('t1', 'plan')
    waitingStateMap.set('t1', 'question')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.questionTabs[0].mode).toBe('plan')
  })

  it('mixed modes are resolved per tab across running and connecting lists', () => {
    permissionModeMap.set('t1', 'plan')
    permissionModeMap.set('t3', 'auto')
    const tabs = [makeTab('t1', 'running'), makeTab('t2', 'running'), makeTab('t3', 'connecting')]
    const c = computeStatusCounts(tabs)
    expect(c.runningTabs.map((t) => t.mode)).toEqual(['plan', 'auto'])
    expect(c.connectingTabs.map((t) => t.mode)).toEqual(['auto'])
  })
})

// ─── Background-shell branch ──────────────────────────────────────────────────

// runningShellIds was wired into the TabStripShared mock when the shell
// dimension shipped, but no test ever populated it — so globalRunningTier's
// shell branch and computeStatusCounts' waitingShells / waitingShellTabs had
// zero coverage and the set existed only to keep the mock shape valid. These
// pin the branch from both directions, matching how the agent branch is pinned
// above.
describe('WorkspaceStatusIndicator — background-shell branch', () => {
  afterEach(() => { runningChildrenIds.clear(); runningShellIds.clear(); waitingStateMap.clear(); permissionQueueMap.clear() })

  it('globalRunningTier reports waiting for an idle tab holding background shells', () => {
    runningShellIds.add('t1')
    expect(globalRunningTier([makeTab('t1', 'idle')])).toBe('waiting')
  })

  it('globalRunningTier still prefers running: a live turn outranks a held shell', () => {
    runningShellIds.add('t2')
    expect(globalRunningTier([makeTab('t1', 'running'), makeTab('t2', 'idle')])).toBe('running')
  })

  it('counts an idle tab with shells in waitingShells, with its name', () => {
    runningShellIds.add('t1')
    const c = computeStatusCounts([makeTab('t1', 'idle', { customTitle: 'Builder' })])
    expect(c.waitingShells).toBe(1)
    expect(c.waitingShellTabs).toEqual([{ id: 't1', title: 'Builder', mode: 'auto' }])
    // Not double-counted into the agent bucket.
    expect(c.waitingChildren).toBe(0)
    expect(c.idle).toBe(0)
  })

  it('agents outrank shells when a tab has both', () => {
    runningChildrenIds.add('t1')
    runningShellIds.add('t1')
    const c = computeStatusCounts([makeTab('t1', 'idle')])
    expect(c.waitingChildren).toBe(1)
    expect(c.waitingShells).toBe(0)
    expect(c.waitingShellTabs).toEqual([])
  })

  it('shells outrank plan-ready and bash — matches getTabStatusColor cascade', () => {
    runningShellIds.add('t1')
    waitingStateMap.set('t1', 'plan-ready')
    const c = computeStatusCounts([makeTab('t1', 'idle', { bashExecuting: true })])
    expect(c.waitingShells).toBe(1)
    expect(c.planReady).toBe(0)
    expect(c.bash).toBe(0)
  })

  it('a terminal-only tab is skipped even when it reports shells', () => {
    runningShellIds.add('t1')
    const c = computeStatusCounts([makeTab('t1', 'idle', { isTerminalOnly: true })])
    expect(c.waitingShells).toBe(0)
  })
})
