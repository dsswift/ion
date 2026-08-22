// @vitest-environment jsdom
//
// WorktreeRow — what the row SAYS about a worktree.
//
// Three properties, each of which was previously wrong or absent:
//
//   1. The primary text is the human title when the worktree has one. Before,
//      it was always the directory slug (`ion-a3f1`) — a machine string that
//      tells the operator nothing about the work. The slug is the fallback, not
//      the preference.
//   2. The open-conversation hint shows a compact parenthesized COUNT whenever
//      conversations live in the worktree. Before, it repeated `open` for one
//      conversation and used a longer count label for several.
//   3. The machine identifiers the row gave up (branch, slug, path) and the
//      conversation list are reachable on hover, so nothing became unreachable
//      in exchange for readability.
//
// Regression directions: reverting `entry.title || entry.label` to `entry.label`
// turns (1) red; replacing parenthesized count with repeated `open` turns (2)
// red; removing the HoverCard turns (3) red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const store = vi.hoisted(() => ({
  tabs: [] as Array<Record<string, unknown>>,
  conversationPanes: new Map<string, unknown>(),
  selectTab: vi.fn(),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof store) => unknown) => selector(store),
    { getState: () => store },
  ),
}))

vi.mock('@phosphor-icons/react', () => ({
  ArrowsClockwise: () => null, ArrowCircleUp: () => null, Bug: () => null,
  ChatCircle: () => null, Check: () => null, CircleNotch: () => null,
  DotsThree: () => null, Warning: () => null,
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null, DeviceMobile: () => null,
  Monitor: () => null, Gear: () => null,
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

import { PopoverLayerProvider } from '../PopoverLayer'
import { WorktreeRow } from '../WorktreeRow'
import type { WorktreeInventoryEntry } from '../../../shared/types'
import type { DirConversation } from '../../../shared/worktree-conversations'

const WT = '/Users/dev/.ion/worktrees/ion-a3f1'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT,
    branchName: 'wt/ion-a3f1',
    label: 'ion-a3f1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'fix token expiry',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
    ...over,
  }
}

function conv(over: Partial<DirConversation> & { tabId: string }): DirConversation {
  return { title: 'A conversation', status: 'idle', index: 1, ...over }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(props: {
  entry: WorktreeInventoryEntry
  openConversations?: DirConversation[]
  active?: boolean
}): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <WorktreeRow
          entry={props.entry}
          openConversations={props.openConversations}
          active={props.active}
          onOpen={() => {}}
          onSync={() => {}}
          onMenu={() => {}}
        />
      </PopoverLayerProvider>,
    )
  })
}

/** Hover the row's name and let the 400 ms intent delay elapse. */
function hoverName(branch: string): void {
  const name = container.querySelector(`[data-testid="worktree-name-${branch}"]`)!
  act(() => {
    name.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  act(() => { vi.advanceTimersByTime(500) })
}

beforeEach(() => {
  vi.useFakeTimers()
  store.tabs = []
  store.conversationPanes = new Map()
  store.selectTab.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('WorktreeRow — primary name', () => {
  it('shows the human title when the worktree has been named', () => {
    render({ entry: entry({ title: 'Fix the token expiry check' }) })

    expect(container.querySelector('[data-testid="worktree-name-wt/ion-a3f1"]')!.textContent)
      .toBe('Fix the token expiry check')
  })

  it('falls back to the directory slug when it has not', () => {
    render({ entry: entry() })

    expect(container.querySelector('[data-testid="worktree-name-wt/ion-a3f1"]')!.textContent)
      .toBe('ion-a3f1')
  })
})

describe('WorktreeRow — open-conversation hint', () => {
  it('shows a parenthesized count for one open conversation', () => {
    render({ entry: entry(), openConversations: [conv({ tabId: 'a', index: 3 })] })

    const label = container.querySelector('[data-testid="worktree-open-label-wt/ion-a3f1"]')!
    expect(label.textContent).toBe('(1)')
  })

  it('names the COUNT when several are open', () => {
    render({
      entry: entry(),
      openConversations: [
        conv({ tabId: 'a', index: 1 }),
        conv({ tabId: 'b', index: 2 }),
        conv({ tabId: 'c', index: 5 }),
      ],
    })

    expect(container.querySelector('[data-testid="worktree-open-label-wt/ion-a3f1"]')!.textContent)
      .toBe('(3)')
  })

  it('shows no hint at all when nothing is open', () => {
    render({ entry: entry(), openConversations: [] })

    // The hint is absent; the open BUTTON stays, because it also creates the
    // first conversation.
    expect(container.querySelector('[data-testid="worktree-open-label-wt/ion-a3f1"]')).toBeNull()
    // The row has NO conversation bubble: clicking the row already opens or
    // cycles, and a bubble duplicated that with the same glyph the bench bar
    // uses for a different verb. Creating an additional conversation lives in
    // the row menu.
    expect(container.querySelector('[data-testid="worktree-open-wt/ion-a3f1"]')).toBeNull()
  })
})

describe('WorktreeRow — hover card', () => {
  it('carries the machine identifiers the row no longer shows', () => {
    render({ entry: entry({ title: 'Fix the token expiry check' }) })

    hoverName('wt/ion-a3f1')

    const card = document.querySelector('[data-testid="hover-card"]')!
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Fix the token expiry check')
    expect(card.textContent).toContain('wt/ion-a3f1')
    expect(card.textContent).toContain('ion-a3f1')
    expect(card.textContent).toContain(WT)
  })

  it('lists every open conversation by name', () => {
    render({
      entry: entry({ title: 'Fix the token expiry check' }),
      openConversations: [
        conv({ tabId: 'a', title: 'Fix the parser', index: 2 }),
        conv({ tabId: 'b', title: 'Add tests', index: 4 }),
      ],
    })

    hoverName('wt/ion-a3f1')

    const card = document.querySelector('[data-testid="hover-card"]')!
    // By NAME. The card used to print a `tab N` index alongside each title --
    // a number nothing in the app displays, and one that silently goes wrong
    // when tabs are reordered.
    expect(card.textContent).toContain('Fix the parser')
    expect(card.textContent).toContain('Add tests')
    expect(card.textContent).not.toMatch(/tab \d/)
  })

  it('renders canonical live status for every listed conversation', () => {
    store.tabs = [
      { id: 'a', status: 'running', pillIcon: null, manualUnread: false, lastCompletionAt: null, lastVisitedAt: null },
      { id: 'b', status: 'idle', pillIcon: null, manualUnread: false, lastCompletionAt: null, lastVisitedAt: null },
    ]
    render({
      entry: entry(),
      openConversations: [conv({ tabId: 'a', title: 'Run' }), conv({ tabId: 'b', title: 'Wait' })],
    })

    hoverName('wt/ion-a3f1')

    const running = document.querySelector('[data-testid="worktree-conversation-status-a"]')!
    const idle = document.querySelector('[data-testid="worktree-conversation-status-b"]')!
    expect(running.firstElementChild?.className).toContain('animate-pulse-dot')
    expect(idle.firstElementChild?.className).not.toContain('animate-pulse-dot')
  })
  it('says so plainly when no conversation is open there', () => {
    render({ entry: entry(), openConversations: [] })

    hoverName('wt/ion-a3f1')

    expect(document.querySelector('[data-testid="hover-card-no-conversations"]')!.textContent)
      .toContain('No conversations open')
  })

  it('does not open the card before the hover-intent delay elapses', () => {
    render({ entry: entry() })
    const name = container.querySelector('[data-testid="worktree-name-wt/ion-a3f1"]')!

    act(() => {
      name.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    act(() => { vi.advanceTimersByTime(100) })

    expect(document.querySelector('[data-testid="hover-card"]')).toBeNull()
  })
})

/**
 * Orientation: "where am I working?"
 *
 * With dozens of worktrees open, neither the tab strip (which tab is focused)
 * nor the workspace indicator (which conversations are live) says which
 * CHECKOUT the current conversation belongs to — and a worktree's registry title
 * routinely differs from its conversation's title. These two additions are the
 * panel's answer: a rail marking the current row, and the one identifier that
 * correlates the panel against the tab strip and the branch name.
 */
describe('WorktreeRow — active worktree', () => {
  it('marks the row when the active conversation is here', () => {
    render({ entry: entry(), active: true })
    expect(container.querySelector('[data-testid="worktree-active-wt/ion-a3f1"]')).toBeTruthy()
  })

  it('does not mark the row otherwise', () => {
    render({ entry: entry(), active: false })
    expect(container.querySelector('[data-testid="worktree-active-wt/ion-a3f1"]')).toBeFalsy()
  })

  it('carries the state in the hover card heading, not colour alone', () => {
    // Colour must never be the only carrier of a state — an operator who cannot
    // separate the hues still has to be able to read it.
    render({ entry: entry(), active: true })
    hoverName('wt/ion-a3f1')
    expect(document.body.textContent).toContain('you are here')
  })

  it('composes the rail with the drag drop-target rule rather than replacing it', () => {
    // Both facts can be true at once: this row is current AND a drop would land
    // here. Choosing between them would hide one.
    act(() => {
      root.render(
        <PopoverLayerProvider>
          <WorktreeRow
            entry={entry()}
            active
            dropTarget
            onOpen={() => {}}
            onSync={() => {}}
            onMenu={() => {}}
          />
        </PopoverLayerProvider>,
      )
    })
    const row = container.querySelector('[data-testid="worktree-row-wt/ion-a3f1"]') as HTMLElement
    expect(row.style.boxShadow).toContain('inset 2px 0')
    expect(row.style.boxShadow).toContain('inset 0 1px')
  })
})

describe('WorktreeRow — worktree ID on line 2', () => {
  it('shows the directory ID, the token shared with the branch and the path', () => {
    render({ entry: entry() })
    const id = container.querySelector('[data-testid="worktree-id-wt/ion-a3f1"]')
    expect(id?.textContent).toBe('ion-a3f1')
  })

  it('keeps the ID when a long commit subject would otherwise consume the line', () => {
    // The ID is the thing being correlated; truncating it defeats the purpose,
    // so the subject yields width first (flexShrink: 0 on the ID).
    render({ entry: entry({ lastCommitSubject: 'x'.repeat(400) }) })
    const id = container.querySelector('[data-testid="worktree-id-wt/ion-a3f1"]') as HTMLElement
    expect(id.textContent).toBe('ion-a3f1')
    expect(id.style.flexShrink).toBe('0')
  })

  it('still shows the ID for a worktree with no commits', () => {
    render({ entry: entry({ lastCommitSubject: '' }) })
    expect(container.querySelector('[data-testid="worktree-id-wt/ion-a3f1"]')?.textContent).toBe('ion-a3f1')
    expect(container.textContent).toContain('no commits yet')
  })
})
