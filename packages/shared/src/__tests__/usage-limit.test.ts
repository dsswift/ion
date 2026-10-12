import { describe, expect, it } from 'vitest'
import type { FleetAccountLimit } from '../types-fleet'
import { accountHasRoom, expiringQuota, hasSpareQuota, rateLimitNotice, rateLimitUtilization, sameResetWindow, unusedAtReset, unusedAtResetLabel, usageLimitLabel, usageLimitedUntil } from '../usage-limit'
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

describe('rateLimitNotice', () => {
  const resetsAt = Math.floor((NOW + HOUR) / 1000)

  it('says nothing about a request that was simply allowed', () => {
    expect(rateLimitNotice({ status: 'allowed', rateLimitType: 'five_hour', resetsAt }, NOW)).toBeNull()
  })

  it('words a warning as a warning, never as a refusal', () => {
    const notice = rateLimitNotice({ status: 'allowed_warning', rateLimitType: 'seven_day_overage_included', resetsAt, utilization: 0.873 }, NOW)
    expect(notice).toMatch(/^Approaching the 7-day limit \(87% used\)\. Requests are still allowed\. Resets at /)
    expect(notice).not.toMatch(/reached|rate limited/i)
  })

  it('reads the percent from the matching window, and leaves it out when unknown', () => {
    const fromWindow = rateLimitNotice({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt, windows: { five_hour: { utilization: 0.9 } } }, NOW)
    expect(fromWindow).toContain('5-hour limit (90% used)')
    expect(rateLimitUtilization({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt })).toBeNull()
    expect(rateLimitNotice({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt }, NOW)).toMatch(/^Approaching the 5-hour limit\. /)
  })

  it('says the limit was reached only on a refusal', () => {
    expect(rateLimitNotice({ status: 'rejected', rateLimitType: 'seven_day', resetsAt }, NOW)).toMatch(/^7-day limit reached\. Resets at /)
  })

  it('names the day when the reset is more than a day out', () => {
    const far = Math.floor((NOW + 72 * HOUR) / 1000)
    const weekday = new Date(far * 1000).toLocaleString(undefined, { weekday: 'short' })
    expect(rateLimitNotice({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: far }, NOW)).toContain(weekday)
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

  it('lists what each weekly limit loses at the reset, a model first, once one of them is expiring', () => {
    const rule = { withinHours: 12, unusedPercent: 25 }
    const weekly = limit({ percent: 57 })
    const model = limit({ kind: 'weekly_model', label: 'Model One', percent: 79 })
    const spent = limit({ kind: 'weekly_model', label: 'Model Two', percent: 100 })
    const lost = unusedAtReset([limit({ kind: 'session', percent: 10 }), weekly, spent, model], NOW, rule)
    // The model's 21% is under the rule's 25%, and is still named beside the 43% that is over it.
    expect(lost.map((entry) => unusedAtResetLabel(entry, lost))).toEqual(['21% Model One unused', '43% total unused'])
    const alone = unusedAtReset([weekly], NOW, rule)
    expect(alone.map((entry) => unusedAtResetLabel(entry, alone))).toEqual(['43% unused'])
    // Nothing is over the rule's share: nothing is listed.
    expect(unusedAtReset([limit({ percent: 80 }), model], NOW, rule)).toEqual([])
  })

  it('reads two reset times a moment apart as one window, and ones hours apart as two', () => {
    expect(sameResetWindow(NOW + 905, NOW - 448)).toBe(true)
    expect(sameResetWindow(NOW, NOW + 7 * 24 * HOUR)).toBe(false)
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
