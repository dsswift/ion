// @vitest-environment jsdom
/**
 * Honest last-activity (D2): the semantic fix for the any-event-counts lie.
 *
 *   - reconnect/heartbeat-style events stamp lastEventAt but NOT
 *     lastActivityAt
 *   - task_complete stamps lastActivityAt + lastCompletionAt + idleSince
 *   - completion stays unread until a later visit
 *   - setTabStatus running→idle stamps idleSince; idle→idle and
 *     restore-time writes never do
 *   - restoration backfill resolves max(persisted, SessionMeta
 *     lastTimestamp), never Date.now()
 */
import { describe, it, expect } from 'vitest'
import { inboxUnread, tabUnread } from '../../../shared/inbox-classify'
import { setTabStatus } from '../slices/tab-status-transition'
import { resolveBackfilledActivity } from '../../hooks/useTabRestoration-activity'
import type { TabState } from '../../../shared/types'

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    status: 'running',
    lastEventAt: null,
    lastActivityAt: null,
    idleSince: null,
    lastCompletionAt: null,
    historicalSessionIds: [],
    bashResults: [],
    queuedPrompts: [],
    ...over,
  } as unknown as TabState
}

describe('setTabStatus idleSince stamping', () => {
  it('running→idle stamps idleSince', () => {
    const before = Date.now()
    const next = setTabStatus([tab({ status: 'running' })], 'tab-1', 'idle', 'event.status-transition')
    expect(next[0].idleSince).toBeGreaterThanOrEqual(before)
  })

  it('connecting→completed stamps idleSince (came to rest)', () => {
    const next = setTabStatus([tab({ status: 'connecting' })], 'tab-1', 'completed', 'event.task-complete')
    expect(next[0].idleSince).not.toBeNull()
  })

  it('idle→running does NOT stamp idleSince', () => {
    const next = setTabStatus([tab({ status: 'idle', idleSince: 12345 })], 'tab-1', 'running', 'implement.plan')
    expect(next[0].idleSince).toBe(12345) // restored value survives
  })

  it('same-status no-op returns the same reference (no restamp)', () => {
    const tabs = [tab({ status: 'idle', idleSince: 12345 })]
    expect(setTabStatus(tabs, 'tab-1', 'idle', 'event.status-transition')).toBe(tabs)
  })

  it('guard rejection leaves idleSince untouched', () => {
    const tabs = [tab({ status: 'running', idleSince: 777 })]
    const next = setTabStatus(tabs, 'tab-1', 'idle', 'event.status-transition', () => false)
    expect(next).toBe(tabs)
  })
})

describe('restoration backfill resolution', () => {
  it('max(persisted, meta) wins in both directions', () => {
    expect(resolveBackfilledActivity(100, 200)).toBe(200)
    expect(resolveBackfilledActivity(300, 200)).toBe(300)
  })
  it('null persisted takes the meta value (pre-upgrade tabs)', () => {
    expect(resolveBackfilledActivity(null, 200)).toBe(200)
  })
  it('null meta keeps the persisted value', () => {
    expect(resolveBackfilledActivity(100, null)).toBe(100)
  })
  it('both null stays null — NEVER Date.now()', () => {
    expect(resolveBackfilledActivity(null, null)).toBeNull()
  })
})

describe('completion review state', () => {
  it('stays unread until a visit occurs after the completion', () => {
    const completed = tab({ lastMessageAt: 1_000, lastCompletionAt: 3_000, lastVisitedAt: 2_000 })
    expect(inboxUnread({ ...completed, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, manualUnread: false, pendingAskCount: 0, waiting: false, failed: false })).toBe(true)
    expect(tabUnread(completed)).toBe(true)

    const reviewed = { ...completed, lastVisitedAt: 4_000 }
    expect(inboxUnread({ ...reviewed, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, manualUnread: false, pendingAskCount: 0, waiting: false, failed: false })).toBe(false)
    expect(tabUnread(reviewed)).toBe(false)
  })
})

describe('structural: lastActivityAt write sites are the genuine-activity set', () => {
  // The honest-activity contract is enforced by WHO writes the field. The
  // any-event reducer (event-slice.ts) stamps lastEventAt only; if a future
  // change adds lastActivityAt stamping there, reconnect/heartbeat events
  // would resurrect the lie this field exists to fix.
  it('event-slice.ts (the any-event reducer) never writes lastActivityAt', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.resolve(__dirname, '../slices/event-slice.ts'), 'utf-8')
    expect(src.includes('lastActivityAt')).toBe(false)
  })

  it('permissions-slice.ts (watchdog restamps) never writes lastActivityAt', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.resolve(__dirname, '../slices/permissions-slice.ts'), 'utf-8')
    expect(src.includes('lastActivityAt')).toBe(false)
  })
})
