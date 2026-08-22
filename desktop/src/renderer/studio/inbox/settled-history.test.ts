import { describe, expect, it } from 'vitest'
import {
  paginateSettled,
  partitionSettled,
  searchSettledTabs,
  SETTLED_HISTORY_CUTOFF_DAYS,
  SETTLED_HISTORY_PAGE_SIZE,
} from './settled-history'
import type { TabState, WorktreeInventoryEntry } from '../../../shared/types'

function tab(overrides: Partial<TabState>): TabState {
  return {
    id: 'tab', title: 'Conversation', workingDirectory: '/repo', settledAt: null, worktree: null, ...overrides,
  } as TabState
}

describe('settled history', () => {
  it('keeps only the 30-day history window and excludes older records', () => {
    const now = Date.UTC(2026, 0, 31)
    const cutoff = now - SETTLED_HISTORY_CUTOFF_DAYS * 24 * 60 * 60 * 1_000
    const result = partitionSettled([
      tab({ id: 'recent', settledAt: cutoff }),
      tab({ id: 'expired', settledAt: cutoff - 1 }),
      tab({ id: 'untimestamped' }),
    ], now)

    expect(result.recent.map(({ id }) => id)).toEqual(['recent', 'untimestamped'])
    expect(result.history.map(({ id }) => id)).toEqual(['recent', 'untimestamped'])
  })

  it('searches title overrides and source project names', () => {
    const tabs = [
      tab({ id: 'title', title: 'Original title', customTitle: 'Release notes' }),
      tab({ id: 'project', title: 'Conversation', workingDirectory: '/projects/ion' }),
    ]

    const inventory = new Map<string, readonly WorktreeInventoryEntry[]>([['/projects/ion', [{
      worktreePath: '/projects/ion/wt/inbox', title: 'Inbox recovery', label: 'ion-inbox', branchName: 'wt/ion-inbox',
    } as WorktreeInventoryEntry]]])
    const worktree = tab({ id: 'worktree', title: 'Conversation', workingDirectory: '/projects/ion/wt/inbox', worktree: { repoPath: '/projects/ion', worktreePath: '/projects/ion/wt/inbox', branchName: 'wt/ion-inbox', sourceBranch: 'main' } })

    expect(searchSettledTabs([...tabs, worktree], 'rln', new Map()).map(({ id }) => id)).toEqual(['title'])
    expect(searchSettledTabs([...tabs, worktree], 'ion', new Map()).map(({ id }) => id)).toEqual(['project', 'worktree'])
    expect(searchSettledTabs([...tabs, worktree], 'recovery', new Map(), inventory).map(({ id }) => id)).toEqual(['worktree'])
    expect(searchSettledTabs(tabs, '', new Map())).toEqual(tabs)
  })

  it('returns a zero-based page with correct metadata', () => {
    const tabs = Array.from({ length: SETTLED_HISTORY_PAGE_SIZE + 1 }, (_, index) => tab({ id: String(index) }))

    expect(paginateSettled(tabs, 0)).toMatchObject({
      page: tabs.slice(0, SETTLED_HISTORY_PAGE_SIZE),
      totalPages: 2,
      hasMore: true,
    })
    expect(paginateSettled(tabs, 1)).toMatchObject({
      page: [tabs.at(-1)],
      totalPages: 2,
      hasMore: false,
    })
  })
})
