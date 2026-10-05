import { describe, expect, it } from 'vitest'
import type { FleetAccountLimit } from '../types-fleet'
import { accountHasRoom, expiringQuota, hasSpareQuota, usageLimitLabel, usageLimitedUntil } from '../usage-limit'
import { effectiveSnoozed, inboxQuiet, type InboxTabView } from '../inbox-classify'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()

function limit(over: Partial<FleetAccountLimit>): FleetAccountLimit {
  return { kind: 'weekly', percent: 50, resetsAt: iso(NOW + 6 * HOUR), fetchedAt: NOW - HOUR, ...over }
}

function view(over: Partial<InboxTabView> = {}): InboxTabView {
  return {
    status: 'idle', settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null,
    lastVisitedAt: NOW, lastCompletionAt: NOW - HOUR, lastMessageAt: NOW - HOUR, manualUnread: false,
    pendingAskCount: 0, waiting: false, failed: false, ...over,
  }
}

describe('usageLimitedUntil', () => {
  it('holds until the reset and not after it', () => {
    const tab = { usageLimit: { limitType: 'five_hour', resetsAt: NOW + HOUR, hitAt: NOW - HOUR } }
    expect(usageLimitedUntil(tab, NOW)).toBe(NOW + HOUR)
    expect(usageLimitedUntil(tab, NOW + HOUR)).toBeNull()
    expect(usageLimitedUntil({ usageLimit: null }, NOW)).toBeNull()
  })

  it('names the windows it knows', () => {
    expect(usageLimitLabel('five_hour')).toBe('5-hour limit')
    expect(usageLimitLabel('seven_day')).toBe('7-day limit')
    expect(usageLimitLabel('seven_day_opus')).toBe('7-day limit')
  })
})

describe('expiring quota', () => {
  it('is a weekly limit close to its reset with enough unused', () => {
    const found = expiringQuota([limit({ percent: 60 })], NOW, { withinHours: 12, unusedPercent: 25 })
    expect(found).toHaveLength(1)
    expect(found[0].unusedPercent).toBe(40)
  })

  it('leaves out a far reset, a nearly spent limit, the 5-hour window, and a limit already reset', () => {
    const rule = { withinHours: 12, unusedPercent: 25 }
    expect(expiringQuota([limit({ resetsAt: iso(NOW + 30 * HOUR) })], NOW, rule)).toEqual([])
    expect(expiringQuota([limit({ percent: 90 })], NOW, rule)).toEqual([])
    expect(expiringQuota([limit({ kind: 'session' })], NOW, rule)).toEqual([])
    expect(expiringQuota([limit({ resetsAt: iso(NOW - HOUR) })], NOW, rule)).toEqual([])
  })

  it('is spare only while the account can take work', () => {
    const weekly = limit({ percent: 40 })
    expect(hasSpareQuota([weekly, limit({ kind: 'session', percent: 30, resetsAt: iso(NOW + HOUR) })], NOW)).toBe(true)
    expect(hasSpareQuota([weekly, limit({ kind: 'session', percent: 100, resetsAt: iso(NOW + HOUR) })], NOW)).toBe(false)
  })

  it('reads a used-up limit whose window has since reset as room', () => {
    expect(accountHasRoom([limit({ kind: 'session', percent: 100, resetsAt: iso(NOW - HOUR), fetchedAt: NOW - 2 * HOUR })], NOW)).toBe(true)
  })
})

describe('a limited conversation in the inbox', () => {
  it('stays snoozed through its own failed run', () => {
    const snoozed = { snoozedUntil: NOW + HOUR, snoozedAt: NOW - HOUR, failed: true }
    expect(effectiveSnoozed(view(snoozed), NOW)).toBe(false)
    expect(effectiveSnoozed(view({ ...snoozed, limited: true }), NOW)).toBe(true)
  })

  it('is quiet only once something is queued to resume it', () => {
    expect(inboxQuiet(view({ limited: true, failed: true }), NOW, { deferred: false })).toBe(false)
    expect(inboxQuiet(view({ limited: true, failed: true }), NOW, { deferred: true })).toBe(true)
  })

  it('reads working and read-idle rows as quiet, and unread, failed, or waiting rows as not', () => {
    expect(inboxQuiet(view({ status: 'running' }), NOW, { deferred: false })).toBe(true)
    expect(inboxQuiet(view(), NOW, { deferred: false })).toBe(true)
    expect(inboxQuiet(view({ lastVisitedAt: NOW - 2 * HOUR }), NOW, { deferred: false })).toBe(false)
    expect(inboxQuiet(view({ failed: true }), NOW, { deferred: false })).toBe(false)
    expect(inboxQuiet(view({ pendingAskCount: 1 }), NOW, { deferred: false })).toBe(false)
  })
})
