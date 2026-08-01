/**
 * Collection + rotation pins for the worktree conversation helper.
 *
 * Regression directions:
 *   - Reverting `collectDirConversations` to a `findIndex`-style single match
 *     turns the multi-match tests red.
 *   - Reverting `pickNextConversation` to "always the first match" (the old
 *     `tabs.find(...)` behaviour in openWorktreeConversation) turns the
 *     rotation tests red.
 */
import { describe, it, expect } from 'vitest'
import {
  collectDirConversations,
  pickNextConversation,
  describeOpenConversations,
  type DirConversationSource,
} from '../worktree-conversations'

const WT = '/Users/dev/.ion/worktrees/ion-a3f1'
const OTHER = '/Users/dev/src/ion'

function tab(over: Partial<DirConversationSource> & { id: string }): DirConversationSource {
  return {
    title: 'New Tab',
    customTitle: null,
    status: 'idle',
    workingDirectory: OTHER,
    ...over,
  }
}

describe('collectDirConversations', () => {
  it('returns every match in tab order with the 1-based GLOBAL tab index', () => {
    const tabs = [
      tab({ id: 'a' }),                                  // index 1, other dir
      tab({ id: 'b', workingDirectory: WT, title: 'Fix the parser' }),  // index 2
      tab({ id: 'c' }),                                  // index 3, other dir
      tab({ id: 'd', workingDirectory: WT, title: 'Add tests' }),       // index 4
    ]

    const found = collectDirConversations(tabs, WT)

    expect(found).toEqual([
      { tabId: 'b', title: 'Fix the parser', status: 'idle', index: 2 },
      { tabId: 'd', title: 'Add tests', status: 'idle', index: 4 },
    ])
  })

  it('prefers customTitle over title', () => {
    const tabs = [tab({ id: 'a', workingDirectory: WT, title: 'auto', customTitle: 'mine' })]
    expect(collectDirConversations(tabs, WT)[0].title).toBe('mine')
  })

  it('carries status through so the card can render a state dot', () => {
    const tabs = [tab({ id: 'a', workingDirectory: WT, status: 'running' })]
    expect(collectDirConversations(tabs, WT)[0].status).toBe('running')
  })

  it('returns nothing for a directory with no conversations', () => {
    expect(collectDirConversations([tab({ id: 'a' })], WT)).toEqual([])
  })

  it('never matches on an empty directory — "no directory" is not a place', () => {
    const tabs = [tab({ id: 'a', workingDirectory: '' }), tab({ id: 'b', workingDirectory: '' })]
    expect(collectDirConversations(tabs, '')).toEqual([])
  })
})

describe('pickNextConversation', () => {
  const matches = collectDirConversations(
    [
      tab({ id: 'one', workingDirectory: WT }),
      tab({ id: 'two', workingDirectory: WT }),
      tab({ id: 'three', workingDirectory: WT }),
    ],
    WT,
  )

  it('advances from the active match to the next one', () => {
    expect(pickNextConversation(matches, 'two')?.tabId).toBe('three')
  })

  it('wraps from the last match back to the first', () => {
    expect(pickNextConversation(matches, 'three')?.tabId).toBe('one')
  })

  it('starts at the first match when the active tab is elsewhere', () => {
    expect(pickNextConversation(matches, 'unrelated-tab')?.tabId).toBe('one')
  })

  it('starts at the first match when there is no active tab', () => {
    expect(pickNextConversation(matches, null)?.tabId).toBe('one')
  })

  it('returns the single match when only one conversation is open', () => {
    const single = collectDirConversations([tab({ id: 'solo', workingDirectory: WT })], WT)
    expect(pickNextConversation(single, 'solo')?.tabId).toBe('solo')
    expect(pickNextConversation(single, 'elsewhere')?.tabId).toBe('solo')
  })

  it('returns null when nothing is open, so the caller creates a conversation', () => {
    expect(pickNextConversation([], 'anything')).toBeNull()
  })
})

describe('describeOpenConversations', () => {
  const three = collectDirConversations(
    [
      tab({ id: 'one', workingDirectory: WT }),
      tab({ id: 'two', workingDirectory: WT }),
      tab({ id: 'three', workingDirectory: WT }),
    ],
    WT,
  )

  it('names the tab when exactly one is open', () => {
    expect(describeOpenConversations(three.slice(0, 1))).toBe('open in tab 1')
  })

  it('names the COUNT when several are open', () => {
    // The old label said "open in tab 1" here, which is true of one of them
    // and false of the row.
    expect(describeOpenConversations(three)).toBe('open in 3 tabs')
  })

  it('says nothing when none are open', () => {
    expect(describeOpenConversations([])).toBeNull()
  })
})
