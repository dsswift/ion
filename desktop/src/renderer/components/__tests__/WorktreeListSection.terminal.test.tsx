// @vitest-environment jsdom
//
// WorktreeListSection — a terminal is not a conversation.
//
// Split from WorktreeListSection.test.tsx, which reached the 600-line cap. These
// are the rules that keep a shell and a conversation distinct in the git panel,
// and the bench-terminal button that depends on them; the fixtures they share
// live in `worktree-list-harness.ts` so the two files cannot disagree about what
// a worktree looks like.
//
// Two defects are pinned here, each by its own route into the same wrong answer:
//
// 1. `collectDirConversations` matched on working directory alone, so a terminal
//    in a worktree or bench directory was counted as an open CONVERSATION -- in
//    the hover card, in the `open xN` labels, and as a rotation target for "go to
//    conversation", which could land the operator in a shell.
// 2. `activityFor` filtered by directory only, and its `length === 0` check is
//    what selects the hollow "nothing open here" ring. `getGroupStatusColor`
//    drops terminal-only tabs internally, so a directory holding only a terminal
//    produced a non-empty array that folded to the idle colour: "no
//    conversations" rendered as "conversations, all idle".
import React from 'react'
import { act } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children, style }: { text: string; children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement('span', { 'data-tooltip': text, style }, children),
}))
vi.mock('../git/HoverCard', () => ({
  HoverCard: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement('span', { style }, children),
}))
vi.mock('../git/ConflictsDialog', () => ({ ConflictsDialog: () => null }))
vi.mock('../WorktreeRowMenu', () => ({ WorktreeRowMenu: () => null }))
vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import {
  REPO, BENCH_PATH, storeState, mountHarness, member, workspace,
} from './worktree-list-harness'
import { WorktreeListSection } from '../WorktreeListSection'

// Dynamic import inside the factory: vi.mock is hoisted above the static
// imports, so referencing the imported helper directly would read an
// uninitialised binding.
vi.mock('../../stores/sessionStore', async () =>
  (await import('./worktree-list-harness')).sessionStoreMock())

const h = mountHarness((props) => React.createElement(WorktreeListSection, props))
const q = (testid: string): HTMLElement | null => h.q(testid)

beforeEach(() => h.setup())
afterEach(() => h.teardown())

describe('the row activity dot', () => {
  it('stays on the hollow ring when only a terminal is open', () => {
    // RED without the `!t.isTerminalOnly` filter in `activityFor`: the row
    // rendered a FILLED grey dot -- "conversations, all idle" -- for a worktree
    // holding no conversation at all.
    storeState.tabs = [{ id: 'shell', workingDirectory: '/wt/a', isTerminalOnly: true }]
    h.render()

    const dot = q('worktree-activity-wt/a')!
    expect(dot.style.background).toBe('transparent')
    expect(dot.style.border).toContain('var(--statusIdle)')
  })

  it('fills once a real conversation is open there', () => {
    // The other side of the conditional: the hollow ring must be the "nothing
    // here" state only, not the permanent state.
    storeState.tabs = [
      { id: 'shell', workingDirectory: '/wt/a', isTerminalOnly: true },
      { id: 'talk', workingDirectory: '/wt/a' },
    ]
    h.render()

    expect(q('worktree-activity-wt/a')!.style.background).not.toBe('transparent')
  })
})

describe('the bench open label', () => {
  it('does not count a bench terminal', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    storeState.tabs = [{ id: 'shell', workingDirectory: BENCH_PATH, isTerminalOnly: true }]
    h.render()

    expect(q('bench-open-label')).toBeNull()
  })

  it('still labels a real bench conversation as open', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    storeState.tabs = [
      { id: 'shell', workingDirectory: BENCH_PATH, isTerminalOnly: true },
      { id: 'talk', workingDirectory: BENCH_PATH },
    ]
    h.render()

    expect(q('bench-open-label')!.textContent).toBe('open')
  })
})

describe('the bench terminal button', () => {
  beforeEach(() => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
  })

  it('renders the conversation button beside the terminal button', () => {
    // The bench conversation is a first-class singleton now: build failures
    // are diagnosed there, attribution routes fixes to the owning member
    // worktree, and containment refuses bench/source edits. Both verbs render.
    h.render()

    expect(q('bench-open-conversation')).not.toBeNull()
    expect(q('bench-open-terminal')).not.toBeNull()
  })

  it('opens (or focuses) the bench conversation singleton on click', () => {
    h.render()

    const talk = q('bench-open-conversation')!
    act(() => { talk.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(storeState.openBenchConversation).toHaveBeenCalledWith(REPO, 'josh')
  })

  it('sits in the bar and opens the bench terminal', () => {
    h.render()

    const terminal = q('bench-open-terminal')!
    expect(terminal).not.toBeNull()
    act(() => { terminal.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(storeState.openBenchTerminal).toHaveBeenCalledWith(REPO, 'josh')
  })

  it('says "open" before the terminal exists and "go to" once it does', () => {
    // Driven by the same derivation the store action uses, so the button cannot
    // promise a new tab and then focus an existing one.
    h.render()
    expect(q('bench-open-terminal')!.parentElement!.getAttribute('data-tooltip'))
      .toBe('Open the bench terminal to build and test')

    storeState.tabs = [{
      id: 'shell', workingDirectory: BENCH_PATH, isTerminalOnly: true, customTitle: 'Bench · josh',
    }]
    h.render()
    expect(q('bench-open-terminal')!.parentElement!.getAttribute('data-tooltip'))
      .toBe('Go to the bench terminal')
  })

  it('reads a terminal the operator renamed as still open', () => {
    // Tier 2 of the identity rule, at the UI seam: a renamed bench terminal must
    // not read as absent, or the button would offer to open a second one.
    storeState.tabs = [{
      id: 'shell', workingDirectory: BENCH_PATH, isTerminalOnly: true, customTitle: 'My shell',
    }]
    h.render()

    expect(q('bench-open-terminal')!.parentElement!.getAttribute('data-tooltip'))
      .toBe('Go to the bench terminal')
  })

  it('ignores a conversation in the bench directory', () => {
    storeState.tabs = [{ id: 'talk', workingDirectory: BENCH_PATH, customTitle: 'Bench · josh' }]
    h.render()

    expect(q('bench-open-terminal')!.parentElement!.getAttribute('data-tooltip'))
      .toBe('Open the bench terminal to build and test')
  })
})
