import { describe, expect, it } from 'vitest'
import { pickNextActiveTab } from '../tab-slice-next-active'
import type { TabState, WorktreeInfo } from '../../../../shared/types'

function worktree(worktreePath: string, repoPath = '/repo', sourceBranch = 'main'): WorktreeInfo {
  return { worktreePath, repoPath, sourceBranch, branchName: `wt/${worktreePath.slice(-1)}` }
}

function tab(over: Omit<Partial<TabState>, 'id'> & { id: string }): TabState {
  return {
    workingDirectory: '/repo',
    worktree: null,
    isTerminalOnly: false,
    lastVisitedAt: null,
    lastActivityAt: null,
    ...over,
  } as TabState
}

function selected(closingId: string, tabs: TabState[]) {
  return pickNextActiveTab(closingId, tabs)
}

describe('pickNextActiveTab', () => {
  it('prefers most recently visited conversation in same worktree', () => {
    const closing = tab({ id: 'close', workingDirectory: '/wt/a', worktree: worktree('/wt/a') })
    const older = tab({ id: 'older', workingDirectory: '/wt/a', worktree: worktree('/wt/a'), lastVisitedAt: 10 })
    const newest = tab({ id: 'newest', workingDirectory: '/wt/a', worktree: worktree('/wt/a'), lastVisitedAt: 20 })
    const result = selected('close', [closing, older, newest])
    expect(result).toMatchObject({ tabId: 'newest', tier: 'same-worktree' })
  })

  it('prefers same repo and source branch before same base from another source', () => {
    const closing = tab({ id: 'close', workingDirectory: '/wt/a', worktree: worktree('/wt/a', '/repo', 'main') })
    const sameSource = tab({ id: 'same-source', workingDirectory: '/wt/b', worktree: worktree('/wt/b', '/repo', 'main'), lastVisitedAt: 1 })
    const otherSource = tab({ id: 'other-source', workingDirectory: '/wt/c', worktree: worktree('/wt/c', '/repo', 'feature'), lastVisitedAt: 99 })
    expect(selected('close', [closing, otherSource, sameSource])).toMatchObject({ tabId: 'same-source', tier: 'same-worktree-source' })
  })

  it('uses same base directory before unrelated conversation', () => {
    const closing = tab({ id: 'close', workingDirectory: '/wt/a', worktree: worktree('/wt/a', '/repo') })
    const base = tab({ id: 'base', workingDirectory: '/repo', lastVisitedAt: 1 })
    const elsewhere = tab({ id: 'elsewhere', workingDirectory: '/other', lastVisitedAt: 99 })
    expect(selected('close', [closing, elsewhere, base])).toMatchObject({ tabId: 'base', tier: 'same-base-directory' })
  })

  it('keeps nested base directories in same locality chain', () => {
    const closing = tab({ id: 'close', workingDirectory: '/repo/packages/app' })
    const base = tab({ id: 'base', workingDirectory: '/repo', lastVisitedAt: 1 })
    const elsewhere = tab({ id: 'elsewhere', workingDirectory: '/other', lastVisitedAt: 99 })
    expect(selected('close', [closing, elsewhere, base])).toMatchObject({ tabId: 'base', tier: 'same-base-directory' })
  })

  it('falls outside base directory only after local buckets empty', () => {
    const closing = tab({ id: 'close', workingDirectory: '/repo' })
    const elsewhere = tab({ id: 'elsewhere', workingDirectory: '/other', lastVisitedAt: 99 })
    expect(selected('close', [closing, elsewhere])).toMatchObject({ tabId: 'elsewhere', tier: 'outside-base-directory' })
  })

  it('uses activity only when neither candidate has been visited', () => {
    const closing = tab({ id: 'close' })
    const old = tab({ id: 'old', lastActivityAt: 20 })
    const recent = tab({ id: 'recent', lastActivityAt: 30 })
    expect(selected('close', [closing, old, recent])).toMatchObject({ tabId: 'recent' })
  })

  it('always favors visit timestamp over activity timestamp', () => {
    const closing = tab({ id: 'close' })
    const visited = tab({ id: 'visited', lastVisitedAt: 10, lastActivityAt: 1 })
    const activeOnly = tab({ id: 'active-only', lastActivityAt: 100 })
    expect(selected('close', [closing, activeOnly, visited])).toMatchObject({ tabId: 'visited' })
  })

  it('uses original tab order for exact recency ties', () => {
    const closing = tab({ id: 'close' })
    const first = tab({ id: 'first', lastVisitedAt: 10 })
    const second = tab({ id: 'second', lastVisitedAt: 10 })
    expect(selected('close', [closing, first, second])).toMatchObject({ tabId: 'first' })
  })

  it('does not let newer terminal displace a conversation', () => {
    const closing = tab({ id: 'close' })
    const conversation = tab({ id: 'conversation', lastVisitedAt: 1 })
    const terminal = tab({ id: 'terminal', isTerminalOnly: true, lastVisitedAt: 99 })
    expect(selected('close', [closing, terminal, conversation])).toMatchObject({ tabId: 'conversation' })
  })

  it('falls back to most recently visited terminal once conversations are gone', () => {
    const closing = tab({ id: 'close' })
    const older = tab({ id: 'older', isTerminalOnly: true, lastVisitedAt: 1 })
    const newest = tab({ id: 'newest', isTerminalOnly: true, lastVisitedAt: 2 })
    expect(selected('close', [closing, older, newest])).toMatchObject({ tabId: 'newest', tier: 'terminal-fallback' })
  })

  it('returns null after final tab closes', () => {
    expect(selected('close', [tab({ id: 'close' })])).toBeNull()
  })
})
