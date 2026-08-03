/**
 * Bench conversation singleton — pickBenchConversation resolution rules and
 * collectDirConversations role exclusion. These are the pure rules every
 * surface (renderer store, remote projection, hover cards) shares, so pinning
 * them here pins the singleton behavior everywhere at once.
 */
import { describe, it, expect } from 'vitest'
import {
  collectDirConversations,
  pickBenchConversation,
  type DirConversationSource,
} from '../worktree-conversations'

const BENCH = '/Users/dev/.ion/integration/repo-main'

type Row = DirConversationSource & { inputLocked?: boolean }

function tab(overrides: Partial<Row> & { id: string }): Row {
  return {
    title: 'Tab',
    customTitle: null,
    status: 'idle',
    workingDirectory: BENCH,
    ...overrides,
  }
}

describe('pickBenchConversation', () => {
  it('resolves the singleton by stored role, not directory order', () => {
    const tabs = [
      tab({ id: 'other' }),
      tab({ id: 'slot', tabRole: 'bench-conversation' }),
    ]
    const found = pickBenchConversation(tabs, BENCH)
    expect(found?.tab.id).toBe('slot')
    expect(found?.adopted).toBe(false)
  })

  it('never matches a role-tagged tab from a different directory', () => {
    const tabs = [tab({ id: 'stale', tabRole: 'bench-conversation', workingDirectory: '/somewhere/else' })]
    expect(pickBenchConversation(tabs, BENCH)).toBeNull()
  })

  it('adopts one legacy role-less conversation in the bench directory', () => {
    const tabs = [tab({ id: 'legacy' })]
    const found = pickBenchConversation(tabs, BENCH)
    expect(found?.tab.id).toBe('legacy')
    expect(found?.adopted).toBe(true)
  })

  it('never adopts a terminal', () => {
    const tabs = [tab({ id: 'shell', isTerminalOnly: true })]
    expect(pickBenchConversation(tabs, BENCH)).toBeNull()
  })

  it('never adopts a locked role-less tab (pre-role auto-fix shape)', () => {
    const tabs = [tab({ id: 'oldfix', inputLocked: true })]
    expect(pickBenchConversation(tabs, BENCH)).toBeNull()
  })

  it('never adopts an explicit non-bench role', () => {
    const tabs = [tab({ id: 'fix', tabRole: 'conflict-auto-fix' })]
    expect(pickBenchConversation(tabs, BENCH)).toBeNull()
  })

  it('prefers the role-tagged slot over an adoptable legacy tab', () => {
    const tabs = [
      tab({ id: 'legacy' }),
      tab({ id: 'slot', tabRole: 'bench-conversation' }),
    ]
    const found = pickBenchConversation(tabs, BENCH)
    expect(found?.tab.id).toBe('slot')
    expect(found?.adopted).toBe(false)
  })

  it('returns null for an empty bench path', () => {
    expect(pickBenchConversation([tab({ id: 'a', workingDirectory: '' })], '')).toBeNull()
  })
})

describe('collectDirConversations role exclusion', () => {
  it('excludes conflict-auto-fix conversations from the operator list', () => {
    const tabs = [
      tab({ id: 'talk', tabRole: 'bench-conversation' }),
      tab({ id: 'fix', tabRole: 'conflict-auto-fix' }),
      tab({ id: 'plain' }),
      tab({ id: 'shell', isTerminalOnly: true }),
    ]
    const out = collectDirConversations(tabs, BENCH)
    expect(out.map((c) => c.tabId)).toEqual(['talk', 'plain'])
  })
})
