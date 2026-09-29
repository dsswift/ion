/**
 * The preview a person confirms before auto-settle turns on is the sweep's
 * own predicate, so the number shown is the number the sweep then acts on.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({ inboxAutoSettleDays: 0 }) } }))
vi.mock('../questions-read', () => ({ activeQuestionsCount: () => 0 }))

import { tabsAutoSettleWouldSettle } from '../auto-settle-sweep'
import type { State } from '../session-store-types'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function tab(id: string, idleDays: number, over: Record<string, unknown> = {}) {
  return { id, title: id, customTitle: null, status: 'idle', settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null, lastCompletionAt: null, lastMessageAt: NOW - idleDays * DAY, lastActivityAt: null, manualUnread: false, ...over }
}

function state(tabs: ReturnType<typeof tab>[]): State {
  return { tabs, conversationPanes: new Map() } as unknown as State
}

describe('tabsAutoSettleWouldSettle', () => {
  const s = state([tab('fresh', 1), tab('stale', 10), tab('ancient', 70), tab('kept', 70, { settledOverride: 'active' })])

  it('settles nothing when auto-settle is off', () => {
    expect(tabsAutoSettleWouldSettle(s, 0, NOW)).toEqual([])
  })

  it('counts exactly the conversations idle past the window', () => {
    expect(tabsAutoSettleWouldSettle(s, 3, NOW).map((t) => t.id)).toEqual(['stale', 'ancient'])
    expect(tabsAutoSettleWouldSettle(s, 60, NOW).map((t) => t.id)).toEqual(['ancient'])
  })

  it('never counts a conversation the person chose to keep active', () => {
    expect(tabsAutoSettleWouldSettle(s, 3, NOW).map((t) => t.id)).not.toContain('kept')
  })
})
