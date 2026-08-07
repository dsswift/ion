// @vitest-environment jsdom
//
// WorktreeListSection — ORIENTATION: "where am I working, and which row is this?"
//
// Split from WorktreeListSection.test.tsx at the 600-line cap, on the seam
// between what the list SAYS about worktrees (the other file: one row per
// worktree, membership, the landed band, the pane fill) and how it orients the
// operator inside a large workspace (here).
//
// The behaviour pinned here exists because a worktree panel is the third way
// this workspace is navigated, after the tab strip's kanban groups and the
// workspace indicator. Neither of those can say which CHECKOUT the focused
// conversation belongs to, and a worktree's registry title routinely differs
// from its conversation's title — so with dozens of worktrees open the operator
// had no way to tell where they were standing.
//
// Two mechanisms, both regression-verified: the active-row rail (revert the
// `activeDirectory` plumbing in shared/worktree-list and these go red), and the
// visibility refresh (revert the listener and the badge stays stale on return).
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
// Dialogs and menus portal into the popover layer; each dialog mock renders a
// distinguishable marker so the tests can assert WHICH dialog opened — the
// bench-conflict badge once opened the ConflictsDialog on the bench directory,
// which probed for an in-progress operation that cannot exist there and
// rendered an empty list with a dead Abort.
vi.mock('../git/ConflictsDialog', () => ({
  ConflictsDialog: ({ directory }: { directory: string }) =>
    React.createElement('div', { 'data-testid': 'conflicts-dialog', 'data-directory': directory }),
}))
vi.mock('../git/BenchConflictDialog', () => ({
  BenchConflictDialog: ({ member }: { member: { branchName: string } }) =>
    React.createElement('div', { 'data-testid': 'bench-conflict-dialog', 'data-branch': member.branchName }),
}))
vi.mock('../WorktreeRowMenu', () => ({ WorktreeRowMenu: () => null }))
// The stage strip portals through the popover layer; hand it the body so the
// picker renders in jsdom without mounting the whole provider tree.
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => document.body,
}))
vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { REPO, storeState, mountHarness } from './worktree-list-harness'
import { WorktreeListSection } from '../WorktreeListSection'

// Dynamic import inside the factory: vi.mock is hoisted above the static
// imports, so referencing the imported helper directly would read an
// uninitialised binding.
vi.mock('../../stores/sessionStore', async () =>
  (await import('./worktree-list-harness')).sessionStoreMock())

const h = mountHarness((props) => React.createElement(WorktreeListSection, props))

beforeEach(() => h.setup())
afterEach(() => h.teardown())


describe('WorktreeListSection — active worktree highlight', () => {
  it('marks the row for the active conversation, and only that row', () => {
    storeState.tabs = [
      { id: 't-a', workingDirectory: '/wt/a' },
      { id: 't-b', workingDirectory: '/wt/b' },
    ]
    storeState.activeTabId = 't-b'
    h.render()

    expect(h.q('worktree-active-wt/b')).toBeTruthy()
    expect(h.q('worktree-active-wt/a')).toBeFalsy()
    expect(h.q('worktree-active-wt/c')).toBeFalsy()
  })

  it('follows the focus when the active conversation changes', () => {
    storeState.tabs = [
      { id: 't-a', workingDirectory: '/wt/a' },
      { id: 't-b', workingDirectory: '/wt/b' },
    ]
    storeState.activeTabId = 't-a'
    h.render()
    expect(h.q('worktree-active-wt/a')).toBeTruthy()

    storeState.activeTabId = 't-b'
    h.render()
    expect(h.q('worktree-active-wt/b')).toBeTruthy()
    expect(h.q('worktree-active-wt/a')).toBeFalsy()
  })

  it('resolves through worktree metadata when the tab directory is a subdirectory', () => {
    // A conversation created through the worktree flow carries the checkout root
    // in its metadata even when its cwd sits deeper.
    storeState.tabs = [
      { id: 't-a', workingDirectory: '/wt/a/desktop', worktree: { worktreePath: '/wt/a', repoPath: REPO } },
    ]
    storeState.activeTabId = 't-a'
    h.render()
    expect(h.q('worktree-active-wt/a')).toBeTruthy()
  })

  it('marks nothing when the active conversation is not in any worktree', () => {
    storeState.tabs = [{ id: 't-x', workingDirectory: '/somewhere/else' }]
    storeState.activeTabId = 't-x'
    h.render()
    for (const n of ['a', 'b', 'c']) {
      expect(h.q(`worktree-active-wt/${n}`)).toBeFalsy()
    }
  })

  it('marks nothing when no conversation is active', () => {
    storeState.tabs = [{ id: 't-a', workingDirectory: '/wt/a' }]
    storeState.activeTabId = null
    h.render()
    expect(h.q('worktree-active-wt/a')).toBeFalsy()
  })
})

/**
 * Becoming visible again refreshes immediately.
 *
 * The 5s poll deliberately skips hidden windows, but had no counterpart on
 * return: a backgrounded panel came back showing rows as stale as the moment it
 * was hidden, which is how a resolved conflict's red badge outlived the fix.
 */
describe('WorktreeListSection — refresh on becoming visible', () => {
  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  }

  /**
   * Let the mount-time refresh settle.
   *
   * `refresh` is single-flighted (see utils/single-flight): while one run is in
   * flight, later invocations are DROPPED by design. The mount effect starts one,
   * so without draining it first this suite would measure the gate rather than
   * the visibility listener — and would pass just as happily with no listener.
   */
  async function settleMountRefresh(): Promise<void> {
    await act(async () => { await Promise.resolve() })
  }

  it('refreshes when the document becomes visible', async () => {
    h.render()
    await settleMountRefresh()
    const before = (storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length
    setVisibility('visible')
    expect((storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(before + 1)
  })

  it('does not refresh when the document becomes hidden', async () => {
    h.render()
    await settleMountRefresh()
    const before = (storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length
    setVisibility('hidden')
    expect((storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(before)
    setVisibility('visible')
  })

  it('removes the listener on unmount', async () => {
    h.render()
    await settleMountRefresh()
    h.teardown()
    const before = (storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length
    setVisibility('visible')
    expect((storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(before)
    // Re-mount so the shared afterEach teardown has a root to unmount.
    h.setup()
    h.render()
  })
})
