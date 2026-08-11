// @vitest-environment jsdom
//
// WorktreeListSection — one list, one row per worktree, filling its pane.
//
// Two defects are pinned here.
//
// 1. ONE ROW. This section replaces `WorktreesSection` + `IntegrationSection`,
//    which described the same object twice: a bench member IS a worktree, so an
//    enrolled worktree rendered once in each list, in two components with two
//    vocabularies for the same facts.
//
// 2. THE FILL. Each old section root was a flex item with no `flex` value, so it
//    defaulted to `flex: 0 1 auto` and shrink-wrapped its content. GitPanel
//    sized the pane body correctly, but the scroll viewport inside it ended
//    where the rows ended -- the scrollbar floated in mid-panel above an inert
//    band. jsdom performs no layout, so what is asserted is the DECLARATION that
//    governs the fill; the rendered result is covered by the dev smoke pass.
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

import {
  REPO, storeState, mountHarness, entry, member, workspace,
} from './worktree-list-harness'
import type { IntegrationWorkspace } from '../../../shared/types'
import { WorktreeListSection } from '../WorktreeListSection'

// Dynamic import inside the factory: vi.mock is hoisted above the static
// imports, so referencing the imported helper directly would read an
// uninitialised binding.
vi.mock('../../stores/sessionStore', async () =>
  (await import('./worktree-list-harness')).sessionStoreMock())

const h = mountHarness((props) => React.createElement(WorktreeListSection, props))
const host = (): HTMLDivElement => h.host
const render = (props: { inBenchFor?: string } = {}): void => h.render(props)
const rows = (): Element[] => h.rows()
const q = (testid: string): HTMLElement | null => h.q(testid)

beforeEach(() => h.setup())
afterEach(() => h.teardown())

describe('WorktreeListSection — one row per worktree', () => {
  it('renders an enrolled worktree exactly once', () => {
    // RED under the old split: /wt/a appeared in the Worktrees section AND as a
    // bench member row, so the panel showed one directory twice.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    expect(rows()).toHaveLength(3)
    expect(host().querySelectorAll('[data-testid="worktree-row-wt/a"]')).toHaveLength(1)
  })

  it('shows enrollment as row state rather than a second list', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    expect(q('worktree-enrollment-wt/a')!.getAttribute('data-enrollment')).toBe('included')
    expect(q('worktree-enrollment-wt/b')!.getAttribute('data-enrollment')).toBe('none')
  })

  it('distinguishes excluded from unenrolled', () => {
    // Different facts: `excluded` is in the bench and skipped, `none` is not in
    // the bench at all.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a', { enabled: false })])]]])
    render()

    expect(q('worktree-enrollment-wt/a')!.getAttribute('data-enrollment')).toBe('excluded')
    expect(q('worktree-enrollment-wt/c')!.getAttribute('data-enrollment')).toBe('none')
  })

  it('sorts enrolled worktrees to the top in merge order', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('c'), member('a')])]]])
    render()

    expect(rows().map((r) => r.getAttribute('data-testid')))
      .toEqual(['worktree-row-wt/c', 'worktree-row-wt/a', 'worktree-row-wt/b'])
  })
})

describe('WorktreeListSection — the bench rail', () => {
  it('connects consecutive enrolled rows and stops at the last one', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    // First enrolled row starts the rail but has nothing above it.
    expect(q('worktree-rail-up-wt/a')).toBeNull()
    expect(q('worktree-rail-down-wt/a')).not.toBeNull()
    // Last enrolled row closes it.
    expect(q('worktree-rail-up-wt/b')).not.toBeNull()
    expect(q('worktree-rail-down-wt/b')).toBeNull()
    // Unenrolled rows carry no rail at all.
    expect(q('worktree-rail-up-wt/c')).toBeNull()
    expect(q('worktree-rail-down-wt/c')).toBeNull()
  })
})

describe('WorktreeListSection — drag-reorder within the bench', () => {
  /** A native drag needs a dataTransfer stub; jsdom supplies none. */
  function dragEvent(type: string): Event {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', {
      value: { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' },
    })
    return e
  }

  const row = (branch: string): HTMLElement =>
    host().querySelector(`[data-testid="worktree-row-${branch}"]`) as HTMLElement

  function drag(fromBranch: string, toBranch: string): void {
    act(() => { row(fromBranch).dispatchEvent(dragEvent('dragstart')) })
    act(() => { row(toBranch).dispatchEvent(dragEvent('dragover')) })
    act(() => { row(toBranch).dispatchEvent(dragEvent('drop')) })
  }

  it('makes enrolled rows draggable and leaves unenrolled ones alone', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    expect(row('wt/a').getAttribute('draggable')).toBe('true')
    expect(row('wt/b').getAttribute('draggable')).toBe('true')
    // /wt/c is unenrolled: it has no position in the merge array, so it is not
    // a drag source and not a drop target.
    expect(row('wt/c').getAttribute('draggable')).toBeNull()
  })

  it('commits the new index when an enrolled row is dropped on another', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b'), member('c')])]]])
    render()

    // Third enrolled row dropped on the first.
    drag('wt/c', 'wt/a')

    expect(storeState.benchSetOrder).toHaveBeenCalledWith(REPO, 'josh', '/wt/c', 0)
  })

  it('does not write when a row is dropped on itself', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    drag('wt/a', 'wt/a')

    expect(storeState.benchSetOrder).not.toHaveBeenCalled()
  })

  it('cannot unenroll a row by dragging it onto an unenrolled one', () => {
    // The safety property: a reorder gesture must never change membership. The
    // drop is clamped to the last enrolled position instead.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    act(() => { row('wt/a').dispatchEvent(dragEvent('dragstart')) })
    act(() => { row('wt/c').dispatchEvent(dragEvent('drop')) })

    expect(storeState.benchRemoveMember).not.toHaveBeenCalled()
    // /wt/c is not a drop target at all, so nothing is committed.
    expect(storeState.benchSetOrder).not.toHaveBeenCalled()
  })

  it('marks the dragged row and the drop target differently', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    act(() => { row('wt/a').dispatchEvent(dragEvent('dragstart')) })
    act(() => { row('wt/b').dispatchEvent(dragEvent('dragover')) })

    // The source fades; the destination shows a rule, so the drop reads as a
    // position between rows rather than a selection.
    expect(row('wt/a').style.opacity).toBe('0.4')
    expect(row('wt/b').style.boxShadow).toContain('inset')
  })

  it('clears the drag state on dragend without committing', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('b')])]]])
    render()

    act(() => { row('wt/a').dispatchEvent(dragEvent('dragstart')) })
    act(() => { row('wt/a').dispatchEvent(dragEvent('dragend')) })

    expect(row('wt/a').style.opacity).toBe('1')
    expect(storeState.benchSetOrder).not.toHaveBeenCalled()
  })
})

describe('WorktreeListSection — work stage on line 2', () => {
  // The strip portals into the popover layer (mocked to document.body), so it
  // is queried on the document rather than the harness host.
  const dq = (testid: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${testid}"]`)

  it('offers the stage chip on every row, enrolled or not', () => {
    // The stage lives in the worktree registry, not on a bench member, so an
    // unenrolled worktree carries the control too — `plan` happens before any
    // enrollment exists.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a', { pin: 'behind' })])]]])
    render()

    expect(q('worktree-stage-chip-wt/a')).not.toBeNull()
    expect(q('worktree-stage-chip-wt/c')).not.toBeNull()
  })

  it('sets a stage through the store from the strip', () => {
    render()

    act(() => { (q('worktree-stage-chip-wt/a') as HTMLButtonElement).click() })
    act(() => { (dq('worktree-stage-option-wt/a-build') as HTMLButtonElement).click() })

    expect(storeState.setWorktreeStage).toHaveBeenCalledWith(REPO, '/wt/a', 'build')
  })

  it('clears the stage when the active one is selected again', () => {
    storeState.worktreeInventory = new Map([[REPO, [entry('a', { stage: 'verified' }), entry('b'), entry('c')]]])
    render()

    act(() => { (q('worktree-stage-chip-wt/a') as HTMLButtonElement).click() })
    act(() => { (dq('worktree-stage-option-wt/a-verified') as HTMLButtonElement).click() })

    expect(storeState.setWorktreeStage).toHaveBeenCalledWith(REPO, '/wt/a', null)
  })

  it('marks the active stage in the strip', () => {
    storeState.worktreeInventory = new Map([[REPO, [entry('a', { stage: 'bug' }), entry('b'), entry('c')]]])
    render()

    act(() => { (q('worktree-stage-chip-wt/a') as HTMLButtonElement).click() })

    expect(dq('worktree-stage-option-wt/a-bug')!.getAttribute('aria-pressed')).toBe('true')
    expect(dq('worktree-stage-option-wt/a-test')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not open the conversation when the chip is clicked', () => {
    // The row's own click opens or cycles conversations; the chip sits inside
    // it, so a missing stopPropagation would stage AND navigate.
    render()

    act(() => { (q('worktree-stage-chip-wt/a') as HTMLButtonElement).click() })

    expect(storeState.openWorktreeConversation).not.toHaveBeenCalled()
  })

  it('reserves the line-2 gutter so the commit subject aligns on every row', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    const enrolled = q('worktree-gutter2-wt/a')!
    const unenrolled = q('worktree-gutter2-wt/c')!
    expect(enrolled.style.width).toBe(unenrolled.style.width)
    expect(unenrolled.style.flexShrink).toBe('0')
  })
})

describe('WorktreeListSection — polls while open', () => {
  // The rows describe git state that moves OUTSIDE this window (an agent
  // committing in a worktree, a land elsewhere), and none of those paths bump
  // `refreshKey` — so without a poll the dirty dots and unlanded counts sit
  // stale until the operator touches the panel.
  it('refreshes inventory and bench on an interval, and stops on unmount', async () => {
    vi.useFakeTimers()
    try {
      render()
      // Let the mount refresh settle: each tick only fires when the previous
      // flight has resolved (see the single-flight test below), so the
      // interval assertions must flush microtasks between advances.
      await act(async () => {})
      const baseInventory = (storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length
      const baseBench = (storeState.refreshBench as ReturnType<typeof vi.fn>).mock.calls.length

      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(storeState.refreshWorktreeInventory).toHaveBeenCalledTimes(baseInventory + 1)
      expect(storeState.refreshBench).toHaveBeenCalledTimes(baseBench + 1)

      await act(async () => { vi.advanceTimersByTime(5000) })
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(storeState.refreshWorktreeInventory).toHaveBeenCalledTimes(baseInventory + 3)

      // Unmount stops the poll: a closed panel must not scan git forever.
      h.teardown()
      h.setup()
      const afterUnmount = (storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>).mock.calls.length
      await act(async () => { vi.advanceTimersByTime(15000) })
      expect(storeState.refreshWorktreeInventory).toHaveBeenCalledTimes(afterUnmount)
    } finally {
      vi.useRealTimers()
    }
  })

  // The spawn-storm regression: a tick used to start another full crawl while
  // the previous one was still running, and under load the overlap compounded
  // every 5s until the main process froze. A tick that fires mid-flight must
  // be DROPPED, and the poll must resume once the slow fetch settles.
  it('drops interval ticks while a refresh is still in flight', async () => {
    vi.useFakeTimers()
    try {
      let releaseFirst!: () => void
      const inventoryMock = storeState.refreshWorktreeInventory as ReturnType<typeof vi.fn>
      inventoryMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => { releaseFirst = resolve }),
      )
      render()
      expect(inventoryMock).toHaveBeenCalledTimes(1)

      // Three poll periods pass while the first fetch hangs: no new calls.
      await act(async () => { vi.advanceTimersByTime(15000) })
      expect(inventoryMock).toHaveBeenCalledTimes(1)

      // The slow fetch settles; the next tick polls again.
      await act(async () => { releaseFirst() })
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(inventoryMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorktreeListSection — consistent between a worktree and its bench', () => {
  function twoBenches(): IntegrationWorkspace[] {
    return [
      { ...workspace([member('b')]), sourceBranch: 'main', benchPath: '/bench/main', benchBranch: 'ion/bench/main' },
      workspace([member('a'), member('c')]),
    ]
  }

  it('decorates rows from the bench the panel is standing in, not the first', () => {
    // With several benches the same list reordered itself depending on where the
    // panel was opened from, because `benches[0]` won regardless.
    storeState.benchWorkspaces = new Map([[REPO, twoBenches()]])

    render({ inBenchFor: 'josh' })

    // josh's bench holds a and c, in that order.
    expect(rows().map((r) => r.getAttribute('data-testid')))
      .toEqual(['worktree-row-wt/a', 'worktree-row-wt/c', 'worktree-row-wt/b'])
    expect(q('worktree-enrollment-wt/a')!.getAttribute('data-enrollment')).toBe('included')
    // b belongs to the OTHER bench, so it is unenrolled from this one's view.
    expect(q('worktree-enrollment-wt/b')!.getAttribute('data-enrollment')).toBe('none')
  })

  it('falls back to the first bench when the panel is not inside one', () => {
    storeState.benchWorkspaces = new Map([[REPO, twoBenches()]])
    render()

    // main's bench is first in the list and holds b.
    expect(q('worktree-enrollment-wt/b')!.getAttribute('data-enrollment')).toBe('included')
  })

  it('is unaffected by inBenchFor when the repo has one bench', () => {
    // The common case: both views must agree, which is the consistency the
    // operator asked for.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])

    render()
    const fromWorktree = rows().map((r) => r.getAttribute('data-testid'))

    render({ inBenchFor: 'josh' })
    const fromBench = rows().map((r) => r.getAttribute('data-testid'))

    expect(fromBench).toEqual(fromWorktree)
  })
})

describe('WorktreeListSection — the landed band', () => {
  it('shows no heading when nothing is landed', () => {
    render()
    expect(q('worktree-landed-heading')).toBeNull()
  })

  it('opens the landed band with one heading, whatever its size', () => {
    storeState.worktreeInventory = new Map([[REPO, [
      entry('a'),
      { ...entry('done1'), landedAt: 1, safeToDiscard: true },
      { ...entry('done2'), landedAt: 2, safeToDiscard: true },
    ]]])
    render()

    // One heading, not one per row.
    expect(host().querySelectorAll('[data-testid="worktree-landed-heading"]')).toHaveLength(1)
    expect(q('worktree-landed-heading')!.textContent).toContain('2')
  })

  it('places the heading directly above the first landed row', () => {
    storeState.worktreeInventory = new Map([[REPO, [
      { ...entry('done'), landedAt: 1, safeToDiscard: true },
      entry('active'),
    ]]])
    render()

    const heading = q('worktree-landed-heading')!
    const doneRow = host().querySelector('[data-testid="worktree-row-wt/done"]')!
    const activeRow = host().querySelector('[data-testid="worktree-row-wt/active"]')!

    // Active work first, then the heading, then the completed row.
    expect(activeRow.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(heading.compareDocumentPosition(doneRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves a fresh empty worktree out of the landed band', () => {
    // Clean and fully merged, but it never committed anything -- so it is not
    // landed, and it must not be filed as if work had shipped.
    storeState.worktreeInventory = new Map([[REPO, [{ ...entry('fresh'), safeToDiscard: true }]]])
    render()

    expect(q('worktree-landed-heading')).toBeNull()
  })

  it('sinks an enrolled worktree once its work has landed', () => {
    // Reverses an earlier rule. A member's pin is only an obligation while it
    // holds UNLANDED work; once the work is in the source branch the bench takes
    // that content from its base, and bench-assemble retires the member outright.
    // Keeping it in the active band stranded a finished worktree at the top.
    storeState.worktreeInventory = new Map([[REPO, [{ ...entry('a'), landedAt: 1, safeToDiscard: true }]]])
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    expect(q('worktree-landed-heading')).not.toBeNull()
  })

  it('keeps an enrolled worktree active while its pin still holds work', () => {
    storeState.worktreeInventory = new Map([[REPO, [{ ...entry('a'), unlandedCommitCount: 2 }]]])
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    expect(q('worktree-landed-heading')).toBeNull()
  })
})

describe('WorktreeListSection — fixed bench toolbar and scrolling rows', () => {
  it('fills pane while only row body scrolls', () => {
    render()
    const section = host().firstElementChild as HTMLElement
    const scroll = q('worktree-list-scroll')!

    expect(section.style.flexGrow || section.style.flex).toContain('1')
    expect(section.style.minHeight).toBe('0px')
    expect(section.style.overflow).toBe('hidden')
    expect(scroll.style.flexGrow || scroll.style.flex).toContain('1')
    expect(scroll.style.minHeight).toBe('0px')
    expect(scroll.style.overflowY).toBe('auto')
    expect(scroll.style.overflowX).toBe('hidden')
  })

  it('keeps bench controls outside scrolling rows', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()
    const scroll = q('worktree-list-scroll')!

    expect(scroll.contains(q('bench-assemble'))).toBe(false)
    expect(scroll.contains(q('worktree-new'))).toBe(true)
    expect(scroll.contains(q('worktree-row-wt/a'))).toBe(true)
  })

  it('keeps the New-worktree button from being squeezed by a full list', () => {
    render()
    expect(q('worktree-new')!.style.flexShrink).toBe('0')
  })
})

/**
 * Orientation: the panel marks the worktree the active conversation is in.
 *
 * The third navigation surface (after the tab strip and the workspace indicator)
 * answers a question neither of the others can: with dozens of worktrees open,
 * which CHECKOUT does the focused conversation belong to? Titles do not answer
 * it — a worktree's registry title and its conversation's title routinely differ.
 */
