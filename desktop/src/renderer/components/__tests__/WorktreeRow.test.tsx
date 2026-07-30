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
//   2. The open-conversation hint names the COUNT when several conversations
//      live in the worktree. Before, it said "open in tab 3" no matter how many
//      were open, because the section did a `findIndex` and passed one id —
//      true of one conversation and false of the row.
//   3. The machine identifiers the row gave up (branch, slug, path) and the
//      conversation list are reachable on hover, so nothing became unreachable
//      in exchange for readability.
//
// Regression directions: reverting `entry.title || entry.label` to `entry.label`
// turns (1) red; reverting the label to `open in tab ${index}` turns (2) red;
// removing the HoverCard turns (3) red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@phosphor-icons/react', () => ({
  ArrowsClockwise: () => null, CircleNotch: () => null,
  DotsThree: () => null, Warning: () => null,
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
}): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <WorktreeRow
          entry={props.entry}
          openConversations={props.openConversations}
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
  it('names the tab when exactly one conversation is open', () => {
    render({ entry: entry(), openConversations: [conv({ tabId: 'a', index: 3 })] })

    expect(container.querySelector('[data-testid="worktree-open-wt/ion-a3f1"]')!.textContent)
      .toBe('open in tab 3')
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

    expect(container.querySelector('[data-testid="worktree-open-wt/ion-a3f1"]')!.textContent)
      .toBe('open in 3 tabs')
  })

  it('shows no hint at all when nothing is open', () => {
    render({ entry: entry(), openConversations: [] })

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

  it('lists every open conversation by name and tab number', () => {
    render({
      entry: entry({ title: 'Fix the token expiry check' }),
      openConversations: [
        conv({ tabId: 'a', title: 'Fix the parser', index: 2 }),
        conv({ tabId: 'b', title: 'Add tests', index: 4 }),
      ],
    })

    hoverName('wt/ion-a3f1')

    const card = document.querySelector('[data-testid="hover-card"]')!
    expect(card.textContent).toContain('Fix the parser')
    expect(card.textContent).toContain('tab 2')
    expect(card.textContent).toContain('Add tests')
    expect(card.textContent).toContain('tab 4')
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
