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
  pickDirTerminal,
  benchTerminalTitle,
  type DirConversationSource,
} from '../worktree-conversations'

const WT = '/Users/dev/.ion/worktrees/ion-a3f1'
const BENCH = '/Users/dev/.ion/integration/ion-josh'
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

  it('skips terminal-only tabs — a terminal is not a conversation', () => {
    // RED without the isTerminalOnly skip: the terminal was counted as an open
    // conversation by every consumer at once (hover card, `open ×N` label, iOS
    // projection) and was a rotation target, so "go to conversation" could land
    // the operator in a shell.
    const tabs = [
      tab({ id: 'shell', workingDirectory: WT, isTerminalOnly: true, title: 'Bench · josh' }),
      tab({ id: 'talk', workingDirectory: WT, title: 'Fix the parser' }),
    ]

    expect(collectDirConversations(tabs, WT)).toEqual([
      { tabId: 'talk', title: 'Fix the parser', status: 'idle', index: 2 },
    ])
  })

  it('returns nothing when the directory holds only a terminal', () => {
    // The distinction the row's activity dot depends on: an empty result is
    // "nothing open here" (hollow ring), which is not the same fact as "open
    // and idle" (filled grey dot).
    const tabs = [tab({ id: 'shell', workingDirectory: WT, isTerminalOnly: true })]
    expect(collectDirConversations(tabs, WT)).toEqual([])
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

  it('never rotates onto a terminal, because the collector never offers one', () => {
    // The rotation reads whatever the collector returned, so the terminal skip
    // is what keeps the git panel's "go to conversation" out of a shell.
    const rotatable = collectDirConversations(
      [
        tab({ id: 'shell', workingDirectory: WT, isTerminalOnly: true }),
        tab({ id: 'talk', workingDirectory: WT }),
      ],
      WT,
    )
    expect(pickNextConversation(rotatable, 'talk')?.tabId).toBe('talk')
    expect(pickNextConversation(rotatable, null)?.tabId).toBe('talk')
  })

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

  it('says a conversation is open, without naming a tab number', () => {
    // The label used to read `open in tab 1`. No surface in the app shows a tab
    // number, so the operator could not act on it, and reordering tabs made it
    // wrong. The hover card names the conversations instead.
    expect(describeOpenConversations(three.slice(0, 1))).toBe('open')
  })

  it('names the COUNT when several are open', () => {
    expect(describeOpenConversations(three)).toBe('open ×3')
  })

  it('never emits a digit for a single conversation, whatever its tab index', () => {
    expect(describeOpenConversations(three.slice(2, 3))).not.toMatch(/\d/)
  })

  it('says nothing when none are open', () => {
    expect(describeOpenConversations([])).toBeNull()
  })
})

describe('benchTerminalTitle', () => {
  it('names the bench by its source branch', () => {
    expect(benchTerminalTitle('josh')).toBe('Bench · josh')
  })

  it('is the single name the picker and the creator share', () => {
    // Both sides of the feature read this function rather than a literal. If
    // they drifted, an existing bench terminal would stop matching on tier 1 and
    // every press would open a second one.
    const title = benchTerminalTitle('feat/thing')
    const tabs = [tab({ id: 'shell', workingDirectory: BENCH, isTerminalOnly: true, customTitle: title })]
    expect(pickDirTerminal(tabs, BENCH, title)?.id).toBe('shell')
  })
})

describe('pickDirTerminal', () => {
  const TITLE = benchTerminalTitle('josh')

  it('prefers the terminal Ion named, over tab order', () => {
    // An unrelated shell the operator opened in the bench first must not capture
    // the slot: the named tab is the bench's terminal wherever it sits.
    const tabs = [
      tab({ id: 'stray', workingDirectory: BENCH, isTerminalOnly: true }),
      tab({ id: 'ours', workingDirectory: BENCH, isTerminalOnly: true, customTitle: TITLE }),
    ]
    expect(pickDirTerminal(tabs, BENCH, TITLE)?.id).toBe('ours')
  })

  it('falls back to the first terminal in the directory', () => {
    // Tier 2. This is what adopts a pre-existing untitled shell rather than
    // opening a second one beside it.
    const tabs = [
      tab({ id: 'first', workingDirectory: BENCH, isTerminalOnly: true }),
      tab({ id: 'second', workingDirectory: BENCH, isTerminalOnly: true }),
    ]
    expect(pickDirTerminal(tabs, BENCH, TITLE)?.id).toBe('first')
  })

  it('still finds a terminal the operator renamed', () => {
    // The rename must not orphan the tab -- tier 2 is what keeps the button
    // landing on it, so a renamed bench terminal is never duplicated.
    const tabs = [tab({ id: 'renamed', workingDirectory: BENCH, isTerminalOnly: true, customTitle: 'My shell' })]
    expect(pickDirTerminal(tabs, BENCH, TITLE)?.id).toBe('renamed')
  })

  it('ignores terminals in other directories', () => {
    const tabs = [
      tab({ id: 'elsewhere', workingDirectory: WT, isTerminalOnly: true, customTitle: TITLE }),
      tab({ id: 'home', workingDirectory: OTHER, isTerminalOnly: true }),
    ]
    expect(pickDirTerminal(tabs, BENCH, TITLE)).toBeNull()
  })

  it('never returns a conversation, even one carrying the bench title', () => {
    // The title is not the identity; `isTerminalOnly` is. A conversation the
    // operator happened to name "Bench · josh" is still not a terminal.
    const tabs = [
      tab({ id: 'talk', workingDirectory: BENCH, customTitle: TITLE }),
      tab({ id: 'other-talk', workingDirectory: BENCH }),
    ]
    expect(pickDirTerminal(tabs, BENCH, TITLE)).toBeNull()
  })

  it('returns null when the directory holds no terminal', () => {
    expect(pickDirTerminal([tab({ id: 'talk', workingDirectory: BENCH })], BENCH, TITLE)).toBeNull()
  })

  it('works without a preferred title, taking the first terminal', () => {
    const tabs = [tab({ id: 'shell', workingDirectory: BENCH, isTerminalOnly: true })]
    expect(pickDirTerminal(tabs, BENCH)?.id).toBe('shell')
  })

  it('never matches on an empty directory — "no directory" is not a place', () => {
    const tabs = [tab({ id: 'shell', workingDirectory: '', isTerminalOnly: true })]
    expect(pickDirTerminal(tabs, '', TITLE)).toBeNull()
  })
})
