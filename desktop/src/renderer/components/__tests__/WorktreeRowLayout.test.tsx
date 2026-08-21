// @vitest-environment jsdom
//
// WorktreeRow — the leading control gutter.
//
// What these pin, and the failure each replaces:
//
//   - Controls used to trail an unbounded label, so in a 320px panel a long
//     worktree name pushed the sync button and the ⋯ menu past the right edge.
//     Reaching them meant scrolling sideways.
//   - The label sat inside a <Tooltip> whose wrapper span is the real flex item
//     and had no `minWidth: 0`, so its automatic minimum was the label's full
//     intrinsic width: the ellipsis never engaged and the row overflowed. That
//     overflow is what produced the horizontal scrollbar.
//   - The open indicator renders compact `(N)` text instead of a redundant word,
//     preserving horizontal room the name needs.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
// Passthrough that keeps the wrapper's `style`, because the wrapper IS the flex
// item whose min-width decides whether the label can shrink.
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children, style }: { text: string; children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement('span', { 'data-tooltip': text, style }, children),
}))

import { WorktreeRow, WORKTREE_ROW_GUTTER_WIDTH } from '../WorktreeRow'
import type { WorktreeInventoryEntry } from '../../../shared/types'

const BRANCH = 'wt/a1'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/proj-a1',
    branchName: BRANCH,
    label: 'proj-a1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'feat: things',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onOpen = vi.fn()

function render(e: WorktreeInventoryEntry, props: Partial<Parameters<typeof WorktreeRow>[0]> = {}): void {
  act(() => {
    root.render(React.createElement(WorktreeRow, {
      entry: e,
      onOpen, onSync: () => {}, onMenu: () => {}, onResolve: () => {},
      ...props,
    }))
  })
}

const q = (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`)

/** One open conversation in this worktree. */
function conv(over: Partial<{ tabId: string; title: string; status: string; index: number }> = {}) {
  return { tabId: 't1', title: 'Work', status: 'idle', index: 1, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WorktreeRow — controls lead, name trails', () => {
  it('puts every control before the label in document order', () => {
    // RED before the gutter: the menu, the sync button, and the count all
    // followed the label, which is why a long name hid them.
    render(entry({ unlandedCommitCount: 2, needsSync: true, isDirty: true }))

    const label = q(`worktree-name-${BRANCH}`)!
    for (const id of [
      `worktree-activity-${BRANCH}`,
      `worktree-dirty-${BRANCH}`,
      `worktree-unlanded-${BRANCH}`,
      `worktree-sync-${BRANCH}`,
    ]) {
      const control = q(id)
      expect(control, id).not.toBeNull()
      // DOCUMENT_POSITION_FOLLOWING: the label comes after the control.
      expect(
        control!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${id} must precede the label`,
      ).toBeTruthy()
    }
  })

  it('reserves the same slot widths whether the row is quiet or loaded', () => {
    // The alignment guarantee. An empty slot that collapsed would shift the
    // name left on quiet rows, which is the ragged edge the gutter removes.
    render(entry())
    const quiet = Array.from(q(`worktree-gutter-${BRANCH}`)!.querySelectorAll('[data-ion-slot]'))
      .map((n) => (n as HTMLElement).style.width)

    render(entry({
      unlandedCommitCount: 7,
      operationState: 'rebasing',
      conflictedPaths: ['a.ts'],
      provisionState: 'building',
    }))
    const loaded = Array.from(q(`worktree-gutter-${BRANCH}`)!.querySelectorAll('[data-ion-slot]'))
      .map((n) => (n as HTMLElement).style.width)

    expect(quiet.length).toBeGreaterThan(0)
    expect(loaded).toEqual(quiet)
  })

  it('reserves a full slot for a three-digit count before the state indicator', () => {
    // RED with the former 16px slot: `100↑` extended into the fixed state
    // column and overlapped its sync control.
    render(entry({ unlandedCommitCount: 100, needsSync: true }))

    const slots = Array.from(q(`worktree-gutter-${BRANCH}`)!.querySelectorAll('[data-ion-slot]'))
      .map((node) => node as HTMLElement)
    const countSlot = slots[3]
    const stateSlot = slots[4]
    const count = q(`worktree-unlanded-${BRANCH}`)!

    expect(count.textContent).toBe('100↑')
    expect(countSlot.style.width).toBe('24px')
    expect(countSlot.style.justifyContent).toBe('flex-end')
    expect(countSlot.style.flexShrink).toBe('0')
    expect(stateSlot.style.width).toBe('13px')
    expect(stateSlot.style.flexShrink).toBe('0')
    expect(q(`worktree-sync-${BRANCH}`)).not.toBeNull()
    expect(q(`worktree-gutter-${BRANCH}`)!.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)
  })

  it('sizes the gutter and the second-line indent from the same constant', () => {
    render(entry())

    const gutter = q(`worktree-gutter-${BRANCH}`)!
    expect(gutter.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)
    expect(gutter.style.flexShrink).toBe('0')
    // Line 2 carries a matching gutter column, so its prose aligns under the
    // name and the review buttons get a fixed position of their own.
    const gutter2 = q(`worktree-gutter2-${BRANCH}`)!
    expect(gutter2.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)
  })

  it('lets the label shrink, so a long name ellipsises instead of overflowing', () => {
    // RED before the Tooltip `style` prop: the wrapper span had no minWidth, so
    // its automatic minimum was the label's intrinsic width and the row grew
    // past the panel. This is the horizontal-scrollbar bug.
    render(entry({ label: 'a-very-long-worktree-name-that-would-overflow-a-narrow-panel' }))

    const wrapper = q(`worktree-name-${BRANCH}`)!.parentElement as HTMLElement
    expect(wrapper.style.minWidth).toBe('0px')
    expect(wrapper.style.flex).toContain('1')
    expect(q(`worktree-name-${BRANCH}`)!.style.textOverflow).toBe('ellipsis')
  })
})

describe('WorktreeRow — no conversation bubble', () => {
  it('renders no per-row conversation button at all', () => {
    // Removed rather than restyled. It duplicated the row's own click, and it
    // used the SAME ChatCircle the bench bar uses for Open-conversation while
    // meaning something different -- the row's filled when conversations
    // existed, the bar's never did.
    render(entry(), { openConversations: [conv(), conv()] })
    expect(q(`worktree-open-${BRANCH}`)).toBeNull()
  })

  it('still reports how many conversations are open as a compact count', () => {
    render(entry(), { openConversations: [conv(), conv(), conv()] })
    expect(q(`worktree-open-label-${BRANCH}`)!.textContent).toBe('(3)')
  })

  it('opens or cycles from a click anywhere on the row', () => {
    render(entry(), { openConversations: [conv()] })
    act(() => { q(`worktree-row-${BRANCH}`)!.click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreeRow — one state slot, strict priority', () => {
  it('shows the conflict control and hides sync while an operation is in progress', () => {
    // Mid-rebase the other numbers are meaningless and the only useful action
    // is Resolve, so the slot is not shared.
    render(entry({ operationState: 'rebasing', needsSync: true, conflictedPaths: ['a.ts'] }))

    expect(q(`worktree-conflict-${BRANCH}`)).not.toBeNull()
    expect(q(`worktree-sync-${BRANCH}`)).toBeNull()
    expect(q(`worktree-word-${BRANCH}-conflict-Resolve`)).not.toBeNull()
  })

  it('shows failed provisioning ahead of a stale base', () => {
    render(entry({ provisionState: 'failed', needsSync: true }))

    expect(q(`worktree-provision-failed-${BRANCH}`)).not.toBeNull()
    expect(q(`worktree-sync-${BRANCH}`)).toBeNull()
  })

  it('keeps the dirty-sync refusal visible without hover', () => {
    // Pinned by WorktreeRowSyncBlocked too; asserted here because the marker
    // moved to line 2 when the gutter slot became icon-only.
    render(entry({ needsSync: true, isDirty: true }))
    expect(q(`worktree-word-${BRANCH}-sync-blocked`)).not.toBeNull()
  })
})
