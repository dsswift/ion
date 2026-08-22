/**
 * Inbox classifier rows (D3/D8): settle/snooze precedence, raised hand,
 * auto-settle boundary, never-visited=read, working-never-settles, and
 * snooze-beats-auto-settle.
 */
import { describe, it, expect } from 'vitest'
import { autoSettleBlocked, classifyInbox, effectiveSettled, effectiveSnoozed, inboxUnread, raisedHand, wokeAt, type InboxTabView } from '../inbox-classify'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function view(over: Partial<InboxTabView> = {}): InboxTabView {
  return {
    status: 'idle',
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    lastCompletionAt: null,
    lastMessageAt: NOW - DAY,
    lastActivityAt: NOW - DAY,
    manualUnread: false,
    pendingAskCount: 0,
    waiting: false,
    failed: false,
    ...over,
  }
}

describe('effectiveSnoozed + raised hand', () => {
  it('future wake time classifies snoozed', () => {
    expect(effectiveSnoozed(view({ snoozedUntil: NOW + DAY }), NOW)).toBe(true)
  })
  it('expired wake stops classifying (computed at render, no cron)', () => {
    expect(effectiveSnoozed(view({ snoozedUntil: NOW - 1 }), NOW)).toBe(false)
  })
  it('raised hand resurfaces early only for a real message after snooze', () => {
    const snoozed = { snoozedUntil: NOW + DAY, snoozedAt: NOW - DAY }
    expect(effectiveSnoozed(view({ ...snoozed, pendingAskCount: 1 }), NOW)).toBe(false)
    expect(effectiveSnoozed(view({ ...snoozed, waiting: true }), NOW)).toBe(false)
    expect(effectiveSnoozed(view({ ...snoozed, failed: true }), NOW)).toBe(false)
    expect(effectiveSnoozed(view({ ...snoozed, lastMessageAt: NOW - DAY / 2 }), NOW)).toBe(false)
    // A background run completion alone does not wake a snoozed conversation.
    expect(effectiveSnoozed(view({ ...snoozed, lastMessageAt: NOW - 2 * DAY, lastCompletionAt: NOW - DAY / 2 }), NOW)).toBe(true)
  })
  it('raisedHand itself', () => {
    expect(raisedHand(view({ pendingAskCount: 2 }))).toBe(true)
    expect(raisedHand(view())).toBe(false)
  })
})

describe('effectiveSettled (D8 rows)', () => {
  it('manual settlement wins even when stale runtime state still reports work', () => {
    expect(effectiveSettled(view({ status: 'running', settledOverride: 'settled' }), NOW, 3)).toBe(true)
    expect(effectiveSettled(view({ status: 'connecting', settledOverride: 'settled' }), NOW, 3)).toBe(true)
  })
  it('manual settlement wins over pending plans and user decisions', () => {
    expect(effectiveSettled(view({ hasPendingPlan: true, settledOverride: 'settled' }), NOW, 3)).toBe(true)
    expect(effectiveSettled(view({ pendingAskCount: 1, settledOverride: 'settled' }), NOW, 3)).toBe(true)
    expect(effectiveSettled(view({ waiting: true, settledOverride: 'settled' }), NOW, 3)).toBe(true)
  })
  it('records automatic settlement as a durable hard state', () => {
    expect(effectiveSettled(view({ settledOverride: 'auto', status: 'running' }), NOW, 3)).toBe(true)
    expect(classifyInbox(view({ settledOverride: 'auto' }), NOW, 3)).toBe('settled')
  })
  it('reports each automatic-settlement refusal reason', () => {
    expect(autoSettleBlocked(view({ hasPendingPlan: true }))).toBe('plan_pending')
    expect(autoSettleBlocked(view({ pendingAskCount: 1 }))).toBe('operator_decision_pending')
    expect(autoSettleBlocked(view({ waiting: true }))).toBe('waiting_for_input')
    expect(autoSettleBlocked(view({ hasPendingWork: true }))).toBe('background_work_pending')
    expect(autoSettleBlocked(view({ status: 'running' }))).toBe('session_active')
  })
  it('automatic settlement rejects pending plans and user decisions', () => {
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY, hasPendingPlan: true }), NOW, 3)).toBe(false)
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY, pendingAskCount: 1 }), NOW, 3)).toBe(false)
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY, waiting: true }), NOW, 3)).toBe(false)
  })
  it('user override wins both directions', () => {
    expect(effectiveSettled(view({ settledOverride: 'settled', lastMessageAt: NOW }), NOW, 3)).toBe(true)
    expect(effectiveSettled(view({ settledOverride: 'active', lastMessageAt: NOW - 100 * DAY }), NOW, 3)).toBe(false)
  })
  it('auto-settle boundary: strictly past N days of inactivity', () => {
    expect(effectiveSettled(view({ lastMessageAt: NOW - 3 * DAY - 1 }), NOW, 3)).toBe(true)
    expect(effectiveSettled(view({ lastMessageAt: NOW - 3 * DAY }), NOW, 3)).toBe(false)
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY }), NOW, null)).toBe(false) // off
  })
  it('D8: snooze wins over auto-settle — a snoozed tab never reclassifies settled mid-snooze', () => {
    const idle100days = view({ lastMessageAt: NOW - 100 * DAY, snoozedUntil: NOW + DAY })
    expect(effectiveSettled(idle100days, NOW, 3)).toBe(false)
    expect(classifyInbox(idle100days, NOW, 3)).toBe('snoozed')
  })
  it('unimplemented plans never auto-settle, regardless of age', () => {
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY, hasPendingPlan: true }), NOW, 3)).toBe(false)
  })
  it('background completion cannot delay auto-settle without a message', () => {
    expect(effectiveSettled(view({ lastMessageAt: NOW - 100 * DAY, lastCompletionAt: NOW - 60 * 60 * 1000 }), NOW, 3)).toBe(true)
  })
  it('tabs without a message do not auto-settle', () => {
    expect(effectiveSettled(view({ lastMessageAt: null }), NOW, 3)).toBe(false)
  })
})

describe('inboxUnread (R9/D9 upgrade-day row)', () => {
  it('manual marker wins', () => {
    expect(inboxUnread(view({ manualUnread: true }))).toBe(true)
  })
  it('message after last visit = unread', () => {
    expect(inboxUnread(view({ lastMessageAt: NOW, lastVisitedAt: NOW - DAY }))).toBe(true)
    expect(inboxUnread(view({ lastMessageAt: NOW - 2 * DAY, lastVisitedAt: NOW - DAY }))).toBe(false)
    // Completion alone is not a message and therefore cannot set unread.
    expect(inboxUnread(view({ lastMessageAt: NOW - 2 * DAY, lastCompletionAt: NOW, lastVisitedAt: NOW - DAY }))).toBe(false)
  })
  it('UPGRADE DAY: never-visited (lastVisitedAt null) counts as READ — pre-existing tabs must not all light up', () => {
    expect(inboxUnread(view({ lastMessageAt: NOW, lastVisitedAt: null }))).toBe(false)
  })
})

describe('wokeAt', () => {
  it('expired snooze not yet visited → woke pill', () => {
    expect(wokeAt(view({ snoozedUntil: NOW - DAY, lastVisitedAt: NOW - 2 * DAY }), NOW)).toBe(NOW - DAY)
  })
  it('visited since wake → no pill', () => {
    expect(wokeAt(view({ snoozedUntil: NOW - DAY, lastVisitedAt: NOW - DAY / 2 }), NOW)).toBeNull()
  })
  it('still snoozed → no pill', () => {
    expect(wokeAt(view({ snoozedUntil: NOW + DAY }), NOW)).toBeNull()
  })
})

describe('classifyInbox precedence', () => {
  it('snoozed > settled > active', () => {
    expect(classifyInbox(view({ snoozedUntil: NOW + DAY, settledOverride: 'settled' }), NOW, 3)).toBe('snoozed')
    expect(classifyInbox(view({ settledOverride: 'settled' }), NOW, 3)).toBe('settled')
    expect(classifyInbox(view(), NOW, 3)).toBe('active')
  })
})
