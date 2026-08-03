/**
 * worktree-occupants — the precision guarantees behind "retire closes the tabs
 * in THIS worktree, and only those".
 *
 * ── Why each case here is load-bearing ──────────────────────────────────────
 * Retire deletes a directory. Under-matching leaves a tab pointed at a path that
 * no longer exists (the reported defect); over-matching closes a conversation in
 * an unrelated worktree, which is worse — the operator loses a live thread they
 * never asked to end. The sibling-prefix case is the specific over-match that
 * `isWithinRepo` exists to prevent, and it is reachable in production because
 * worktrees are `<repo>-<hex>` siblings in one parent directory.
 */
import { describe, it, expect } from 'vitest'
import {
  collectOccupants,
  collectOccupantsAcross,
  formatActiveWorktreeRefusal,
  occupantTitle,
  type OccupantTab,
} from '../worktree-occupants'

const WT = '/Users/dev/.ion/worktrees/project-a3372546'
/** Sibling whose path is a string-prefix EXTENSION of WT. The startsWith trap. */
const WT_SIBLING = '/Users/dev/.ion/worktrees/project-a33725460'
const BENCH = '/Users/dev/.ion/integration/project-josh'
const REPO = '/Users/dev/src/project'

function tab(over: Partial<OccupantTab> & { id: string }): OccupantTab {
  return { title: 'New Tab', customTitle: null, workingDirectory: REPO, ...over }
}

describe('collectOccupants', () => {
  it('matches a tab sitting at the directory itself', () => {
    const tabs = [tab({ id: 'a', workingDirectory: WT })]

    expect(collectOccupants(tabs, WT).map((t) => t.id)).toEqual(['a'])
  })

  it('matches a tab in a subdirectory, because the retire removes the whole tree', () => {
    const tabs = [
      tab({ id: 'a', workingDirectory: `${WT}/desktop` }),
      tab({ id: 'b', workingDirectory: `${WT}/desktop/src/renderer` }),
    ]

    expect(collectOccupants(tabs, WT).map((t) => t.id)).toEqual(['a', 'b'])
  })

  // THE over-match case. Regression direction: replace `isWithinRepo` with
  // `startsWith(dirPath)` and this goes red — retiring one worktree would close
  // the conversations of a differently-named sibling.
  it('does NOT match a sibling worktree whose path merely starts with this one', () => {
    const tabs = [
      tab({ id: 'sibling', workingDirectory: WT_SIBLING }),
      tab({ id: 'sibling-child', workingDirectory: `${WT_SIBLING}/desktop` }),
    ]

    expect(collectOccupants(tabs, WT)).toEqual([])
  })

  // A tab created in a worktree with no known source branch is left with
  // `worktree: null` on purpose (newWorktreeConversation). It is still living in
  // the directory, so a metadata-based filter would strand it.
  it('matches on the working directory, so a tab with no worktree metadata counts', () => {
    const tabs = [
      // No `worktree` field at all — the shape this module reads does not have
      // one, which is the point: occupancy is a directory fact.
      tab({ id: 'unlabelled', workingDirectory: WT }),
    ]

    expect(collectOccupants(tabs, WT).map((t) => t.id)).toEqual(['unlabelled'])
  })

  // Unlike collectDirConversations, which skips terminals because a terminal is
  // not a conversation. Here the question is "what is pointed at a dead path".
  it('includes terminal-only tabs', () => {
    const tabs = [
      tab({ id: 'convo', workingDirectory: WT }),
      tab({ id: 'term', workingDirectory: WT, isTerminalOnly: true }),
    ]

    expect(collectOccupants(tabs, WT).map((t) => t.id)).toEqual(['convo', 'term'])
  })

  it('matches nothing for an empty directory, rather than every unset tab', () => {
    const tabs = [tab({ id: 'a', workingDirectory: '' }), tab({ id: 'b', workingDirectory: '~' })]

    expect(collectOccupants(tabs, '')).toEqual([])
  })

  it('leaves tabs in the base repo alone', () => {
    const tabs = [tab({ id: 'repo-tab', workingDirectory: REPO })]

    expect(collectOccupants(tabs, WT)).toEqual([])
  })

  it('preserves tab order', () => {
    const tabs = [
      tab({ id: 'first', workingDirectory: WT }),
      tab({ id: 'elsewhere', workingDirectory: REPO }),
      tab({ id: 'second', workingDirectory: WT }),
    ]

    expect(collectOccupants(tabs, WT).map((t) => t.id)).toEqual(['first', 'second'])
  })
})

describe('collectOccupantsAcross', () => {
  it('collects from the worktree and every pruned bench', () => {
    const tabs = [
      tab({ id: 'wt', workingDirectory: WT }),
      tab({ id: 'bench', workingDirectory: BENCH }),
      tab({ id: 'other', workingDirectory: REPO }),
    ]

    expect(collectOccupantsAcross(tabs, [WT, BENCH]).map((t) => t.id)).toEqual(['wt', 'bench'])
  })

  // Nested roots would otherwise yield the same tab twice, and closing it twice
  // logs a phantom second close.
  it('de-duplicates a tab reachable from two paths', () => {
    const tabs = [tab({ id: 'nested', workingDirectory: `${WT}/desktop` })]

    expect(collectOccupantsAcross(tabs, [WT, `${WT}/desktop`]).map((t) => t.id)).toEqual(['nested'])
  })

  it('returns nothing for an empty path list', () => {
    const tabs = [tab({ id: 'a', workingDirectory: WT })]

    expect(collectOccupantsAcross(tabs, [])).toEqual([])
  })
})

describe('occupantTitle', () => {
  it('prefers the operator-set name', () => {
    expect(occupantTitle(tab({ id: 'a', title: 'New Tab', customTitle: 'Token expiry fix' })))
      .toBe('Token expiry fix')
  })

  it('falls back to the generated title', () => {
    expect(occupantTitle(tab({ id: 'a', title: 'Fix the parser' }))).toBe('Fix the parser')
  })

  it('never renders an empty name', () => {
    expect(occupantTitle(tab({ id: 'a', title: '' }))).toBe('Untitled')
  })
})

describe('formatActiveWorktreeRefusal', () => {
  it('names the single active conversation and its reason', () => {
    const msg = formatActiveWorktreeRefusal([
      { tabId: 't1', title: 'Token expiry fix', reason: 'running' },
    ])

    expect(msg).toContain('still has active work')
    expect(msg).toContain('• Token expiry fix — running')
    // Singular phrasing for one tab.
    expect(msg).toContain('this conversation')
  })

  it('names EVERY active conversation, because the operator must find them all', () => {
    const msg = formatActiveWorktreeRefusal([
      { tabId: 't1', title: 'Token expiry fix', reason: 'running' },
      { tabId: 't2', title: 'Migration sweep', reason: '2 background agents running' },
      { tabId: 't3', title: 'Release checks', reason: '1 background command running' },
    ])

    expect(msg).toContain('• Token expiry fix — running')
    expect(msg).toContain('• Migration sweep — 2 background agents running')
    expect(msg).toContain('• Release checks — 1 background command running')
    expect(msg).toContain('these conversations')
  })

  // The callers treat "nothing active" as proceed and never format a message, so
  // an empty list must not produce a refusal with an empty list under it.
  it('returns nothing for an empty list', () => {
    expect(formatActiveWorktreeRefusal([])).toBe('')
  })
})
