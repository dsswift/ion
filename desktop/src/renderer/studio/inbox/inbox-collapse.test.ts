import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TabState } from '../../../shared/types'
import { collapsedInboxRows, inboxActivityOrder, nextInboxConversation, orderInboxTabs, worktreeChildRows } from './inbox-collapse'

function tab(
  id: string,
  options: Partial<Pick<TabState, 'pinnedAt' | 'pinOrderKey' | 'createdAt' | 'lastActivityAt'>> = {},
): TabState {
  return { id, pinnedAt: null, pinOrderKey: null, createdAt: 0, lastActivityAt: null, ...options } as TabState
}

describe('collapsedInboxRows', () => {
  it('keeps only pinned rows visible when collapsed', () => {
    const tabs = [tab('pinned-later', { pinnedAt: 1, pinOrderKey: 'z' }), tab('active'), tab('pinned-first', { pinnedAt: 2, pinOrderKey: 'a' })]
    expect(collapsedInboxRows(tabs).map(({ id }) => id))
      .toEqual(['pinned-first', 'pinned-later'])
  })

  it('shows every conversation under an expanded worktree and pins only when collapsed', () => {
    const tabs = [tab('plain'), tab('pinned', { pinnedAt: 1 }), tab('other')]
    expect(worktreeChildRows(tabs, false).map(({ id }) => id)).toEqual(['plain', 'pinned', 'other'])
    expect(worktreeChildRows(tabs, true).map(({ id }) => id)).toEqual(['pinned'])
  })

  it('keeps conversation status indicators out of the worktree group header', () => {
    const source = fs.readFileSync(path.join(__dirname, 'InboxWorktreeRow.tsx'), 'utf8')
    expect(source).not.toContain('WorktreeConversationStatusDot')
    expect(source).not.toContain('group.tabs[0]')
  })

  it('uses created time then tab ID as the deterministic fallback pin order', () => {
    const tabs = [
      tab('older-b', { pinnedAt: 1, createdAt: 10 }),
      tab('newer', { pinnedAt: 2, createdAt: 20 }),
      tab('older-a', { pinnedAt: 3, createdAt: 10 }),
    ]
    expect(collapsedInboxRows(tabs).map(({ id }) => id))
      .toEqual(['newer', 'older-a', 'older-b'])
  })

  it('does not duplicate an active pinned row', () => {
    expect(collapsedInboxRows([tab('pinned-active', { pinnedAt: 1 }), tab('other')]).map(({ id }) => id))
      .toEqual(['pinned-active'])
  })
})

describe('Inbox conversation cycling', () => {
  const tabs = [
    tab('older', { lastActivityAt: 10 }),
    tab('tie-b', { pinnedAt: 1, lastActivityAt: 20 }),
    tab('tie-a', { lastActivityAt: 20 }),
    tab('no-activity'),
  ]

  it('orders every conversation by descending activity with a stable ID tie-breaker', () => {
    expect(inboxActivityOrder(tabs).map(({ id }) => id))
      .toEqual(['tie-a', 'tie-b', 'older', 'no-activity'])
  })

  it('uses creation time for a new conversation with no message activity', () => {
    const tabs = [
      { ...tab('older'), lastMessageAt: 20 },
      { ...tab('new'), createdAt: 30, lastMessageAt: null },
    ] as TabState[]
    expect(orderInboxTabs(tabs, 'activity').map(({ id }) => id)).toEqual(['new', 'older'])
  })

  it('includes pinned conversations in activity order and wraps', () => {
    expect(nextInboxConversation(tabs, 'tie-a')?.id).toBe('tie-b')
    expect(nextInboxConversation(tabs, 'no-activity')?.id).toBe('tie-a')
  })

  it('starts at the most active conversation when the active tab is elsewhere', () => {
    expect(nextInboxConversation(tabs, 'elsewhere')?.id).toBe('tie-a')
  })
})
