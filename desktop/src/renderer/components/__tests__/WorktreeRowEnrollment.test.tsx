// @vitest-environment jsdom
//
// WorktreeRow — the enrollment control.
//
// Bench membership is a property OF a worktree, not a different kind of object.
// It used to be expressed by putting the worktree in a second list with a second
// row component; here it is one glyph in the row's gutter with three states.
//
// The ⌥click pairing matters: excluding is a refinement of membership, so both
// live on one control rather than spending a second gutter slot on a state most
// rows never enter. In a 320px panel every reserved slot is width the name loses.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

import { WorktreeRow, WORKTREE_ROW_GUTTER_WIDTH } from '../WorktreeRow'
import type { WorktreeInventoryEntry, IntegrationMember } from '../../../shared/types'

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

function member(over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/proj-a1',
    branchName: BRANCH,
    enabled: true,
    pin: 'current',
    merge: 'merged',
    pinnedSha: 'abc1234',
    pinnedTreeHash: 't1',
    pinnedBaseSha: 'b1',
    currentTreeHash: 't1',
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onToggleEnrollment = vi.fn()
const onToggleIncluded = vi.fn()
const onUpdatePin = vi.fn()
const onResolve = vi.fn()
const onFocusActiveWorktreeResolver = vi.fn()
const onSetStage = vi.fn()

function render(props: Partial<Parameters<typeof WorktreeRow>[0]> = {}): void {
  act(() => {
    root.render(React.createElement(WorktreeRow, {
      entry: entry(),
      onOpen: () => {}, onSync: () => {}, onMenu: () => {}, onResolve,
      onFocusActiveWorktreeResolver,
      onToggleEnrollment, onToggleIncluded, onUpdatePin, onSetStage,
      ...props,
    }))
  })
}

const q = (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`)
const clickToggle = (init: MouseEventInit = {}): void => {
  act(() => {
    q(`worktree-bench-toggle-${BRANCH}`)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
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

describe('WorktreeRow — enrollment states', () => {
  it('reads `none` with no membership', () => {
    render()
    expect(q(`worktree-enrollment-${BRANCH}`)!.getAttribute('data-enrollment')).toBe('none')
    expect(q(`worktree-bench-toggle-${BRANCH}`)!.getAttribute('aria-pressed')).toBe('false')
  })

  it('reads `included` when enrolled and enabled', () => {
    render({ membership: member(), order: 1 })
    expect(q(`worktree-enrollment-${BRANCH}`)!.getAttribute('data-enrollment')).toBe('included')
    expect(q(`worktree-bench-toggle-${BRANCH}`)!.getAttribute('aria-pressed')).toBe('true')
  })

  it('reads `excluded` when enrolled but skipped — not the same as unenrolled', () => {
    render({ membership: member({ enabled: false }), order: 2 })
    expect(q(`worktree-enrollment-${BRANCH}`)!.getAttribute('data-enrollment')).toBe('excluded')
    // Still enrolled: the row is IN the bench, just skipped in the merge.
    expect(q(`worktree-bench-toggle-${BRANCH}`)!.getAttribute('aria-pressed')).toBe('true')
  })

  it('names the merge position in the tooltip when enrolled', () => {
    render({ membership: member(), order: 3 })
    const tips = Array.from(host.querySelectorAll('[data-tooltip]'))
      .map((n) => n.getAttribute('data-tooltip') ?? '')
    expect(tips.some((t) => t.includes('position 3'))).toBe(true)
  })
})

describe('WorktreeRow — the three states are visually distinguishable', () => {
  /**
   * The defect this replaces: `excluded` was a dimmed grey FILL and `none` was a
   * hollow grey outline. At 7px those are the same picture, so an operator with
   * four excluded members read every one of them as unenrolled -- the only
   * difference was 0.45 opacity. The earlier tests passed because they asserted
   * `data-enrollment`, which is invisible.
   */
  function glyph(): HTMLElement {
    return q(`worktree-bench-toggle-${BRANCH}`)!.querySelector('span > span') as HTMLElement
  }

  it('draws an unenrolled diamond hollow, in the neutral colour', () => {
    render()
    expect(glyph().style.background).toBe('transparent')
    expect(glyph().style.border).toContain('textTertiary')
    expect(q('bench-excluded-slash')).toBeNull()
  })

  it('draws an included diamond solid, in the accent colour', () => {
    render({ membership: member(), order: 1 })
    expect(glyph().style.background).toContain('accent')
    expect(q('bench-excluded-slash')).toBeNull()
  })

  it('marks an excluded diamond with a slash, keeping the bench colour', () => {
    // Excluded keeps the ACCENT: the fact it must convey is "is a member,
    // currently skipped". Greying it out is what made it read as "not a member".
    render({ membership: member({ enabled: false }), order: 1 })

    expect(q('bench-excluded-slash')).not.toBeNull()
    expect(glyph().style.border).toContain('accent')
  })

  it('differs from unenrolled by more than opacity', () => {
    render()
    const unenrolled = {
      background: glyph().style.background,
      border: glyph().style.border,
      slash: q('bench-excluded-slash') !== null,
    }

    render({ membership: member({ enabled: false }), order: 1 })
    const excluded = {
      background: glyph().style.background,
      border: glyph().style.border,
      slash: q('bench-excluded-slash') !== null,
    }

    // A shape difference AND a hue difference, either of which is legible at 7px.
    expect(excluded.slash).not.toBe(unenrolled.slash)
    expect(excluded.border).not.toBe(unenrolled.border)
  })
})

describe('WorktreeRow — enrollment interaction', () => {
  it('enrolls on a plain click when unenrolled', () => {
    render()
    clickToggle()
    expect(onToggleEnrollment).toHaveBeenCalledTimes(1)
    expect(onToggleIncluded).not.toHaveBeenCalled()
  })

  it('unenrolls on a plain click when enrolled', () => {
    render({ membership: member(), order: 1 })
    clickToggle()
    expect(onToggleEnrollment).toHaveBeenCalledTimes(1)
  })

  it('flips include/exclude on ⌥click when enrolled', () => {
    render({ membership: member(), order: 1 })
    clickToggle({ altKey: true })
    expect(onToggleIncluded).toHaveBeenCalledTimes(1)
    expect(onToggleEnrollment).not.toHaveBeenCalled()
  })

  it('treats ⌥click on an UNENROLLED row as plain enrollment', () => {
    // There is no include/exclude to flip yet, and silently doing nothing would
    // read as a broken control.
    render()
    clickToggle({ altKey: true })
    expect(onToggleEnrollment).toHaveBeenCalledTimes(1)
    expect(onToggleIncluded).not.toHaveBeenCalled()
  })
})

describe('WorktreeRow — the gutter still aligns with six slots', () => {
  it('reserves the enrollment slot on an unenrolled row', () => {
    // The alignment guarantee: an empty slot that collapsed would shift the name
    // left on unenrolled rows, reproducing the ragged edge the gutter removed.
    render()
    const slot = q(`worktree-enrollment-${BRANCH}`)!
    expect(slot.style.width).toBe('14px')
    expect(slot.style.flexShrink).toBe('0')
  })

  it('reports the same slot widths whether or not the row is enrolled', () => {
    render()
    const unenrolled = Array.from(host.querySelectorAll('[data-ion-slot]'))
      .map((n) => (n as HTMLElement).style.width)

    render({ membership: member({ pin: 'behind' }), order: 1 })
    const enrolled = Array.from(host.querySelectorAll('[data-ion-slot]'))
      .map((n) => (n as HTMLElement).style.width)

    expect(enrolled).toEqual(unenrolled)
  })

  it('sizes the gutter from the six slot widths, and line 2 from the gutter', () => {
    render()
    const gutter = q(`worktree-gutter-${BRANCH}`)!
    expect(gutter.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)

    // Line 2 mirrors the gutter as a real reserved column rather than a bare
    // paddingLeft, so the stage chip lands in a fixed position.
    const gutter2 = q(`worktree-gutter2-${BRANCH}`)!
    expect(gutter2.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)
    expect(gutter2.style.flexShrink).toBe('0')
  })
})

describe('WorktreeRow — activity and dirty are separate indicators', () => {
  const running = { bg: 'var(--statusRunning)', pulse: true, glow: false, glowColor: 'g' }

  it('renders a hollow ring when no conversation is open here', () => {
    // Undefined activity is a different fact from an idle one: "nothing open"
    // versus "open, all idle". The ring says the first.
    render()
    const dot = q(`worktree-activity-${BRANCH}`)!
    expect(dot.style.background).toBe('transparent')
    expect(dot.style.border).toContain('statusIdle')
  })

  it('fills the dot from the shared status cascade when something is open', () => {
    render({ activity: running })
    const dot = q(`worktree-activity-${BRANCH}`)!
    expect(dot.style.background).toContain('statusRunning')
    expect(dot.className).toContain('animate-pulse')
  })

  it('does not pulse an idle worktree', () => {
    render({ activity: { bg: 'var(--statusIdle)', pulse: false, glow: false, glowColor: 'g' } })
    expect(q(`worktree-activity-${BRANCH}`)!.className ?? '').not.toContain('animate-pulse')
  })

  it('shows the dirty marker only when the worktree is dirty', () => {
    render({ entry: entry({ isDirty: false }) })
    expect(q(`worktree-dirty-${BRANCH}`)).toBeNull()

    render({ entry: entry({ isDirty: true }) })
    expect(q(`worktree-dirty-${BRANCH}`)).not.toBeNull()
  })

  it('keeps dirty out of the activity dot entirely', () => {
    // They answer different questions and gate different verbs. The dot used to
    // report dirty in worktreeGreen -- claiming success about unsaved work, and
    // saying nothing about whether anything was running.
    render({ entry: entry({ isDirty: true }) })

    const dot = q(`worktree-activity-${BRANCH}`)!
    expect(dot.style.background).toBe('transparent')
    expect(q(`worktree-dirty-${BRANCH}`)!.style.color).toContain('worktreeDirty')
  })

  it('distinguishes the two by SHAPE as well as hue', () => {
    // At this size a colour difference is a weak signal, and none at all to an
    // operator who cannot separate the hues. The activity dot is a filled
    // circle; dirty is a glyph. It reads as a `git status` mark rather than an
    // error precisely because it is typographic and sits by the commit count.
    render({ entry: entry({ isDirty: true }), activity: running })

    const dot = q(`worktree-activity-${BRANCH}`)!
    const dirty = q(`worktree-dirty-${BRANCH}`)!
    expect(parseFloat(dot.style.borderRadius)).toBeGreaterThanOrEqual(3)
    expect(dirty.textContent).toBe('!')
    // Glyph, not a filled shape: nothing painted behind it.
    expect(dirty.style.background).toBe('')
  })

  it('does not reuse a hue already in this gutter', () => {
    // The teal it briefly used sat between statusRunning (#5EA9C9) and
    // statusComplete (#34d399) -- two cyan-greens, one of them the activity dot
    // right beside it.
    render({ entry: entry({ isDirty: true }), activity: running })

    const dirty = q(`worktree-dirty-${BRANCH}`)!
    expect(dirty.style.color).not.toContain('statusRunning')
    expect(dirty.style.color).not.toContain('statusComplete')
    expect(dirty.style.color).not.toContain('worktreeGreen')
    expect(dirty.style.color).not.toContain('warningFg')
  })

  it('shows both at once, because both can be true', () => {
    render({ entry: entry({ isDirty: true }), activity: running })
    expect(q(`worktree-activity-${BRANCH}`)!.style.background).toContain('statusRunning')
    expect(q(`worktree-dirty-${BRANCH}`)).not.toBeNull()
  })
})

describe('WorktreeRow — membership drives the state slot', () => {
  it('offers an Update-pin control when the bench holds older content', () => {
    render({ membership: member({ pin: 'behind' }), order: 1 })

    const btn = q(`worktree-pin-behind-${BRANCH}`)!
    expect(btn).not.toBeNull()
    act(() => { (btn as HTMLButtonElement).click() })
    expect(onUpdatePin).toHaveBeenCalledTimes(1)
  })

  it('flashes its pin while update runs and locks other stale pins', () => {
    render({ membership: member({ pin: 'behind' }), order: 1, updatingPin: true })
    const active = q(`worktree-pin-behind-${BRANCH}`)!
    expect(active.innerHTML).toContain('animate-spin')
    expect(active.style.animation).toContain('bench-conflict-flash')
    expect(active).toHaveProperty('disabled', true)

    render({ membership: member({ pin: 'behind' }), order: 1, pinUpdateLocked: true })
    const locked = q(`worktree-pin-behind-${BRANCH}`)! as HTMLButtonElement
    expect(locked.disabled).toBe(true)
    expect(locked.style.color).toContain('textTertiary')
  })

  it('flashes a native conflict while its auto-fix resolves it', () => {
    render({
      entry: entry({ operationState: 'rebasing', conflictedPaths: ['a.ts'] }),
      hasActiveWorktreeResolver: true,
    })
    const marker = q(`worktree-conflict-${BRANCH}`)!
    expect(marker.style.animation).toContain('bench-conflict-flash')
    act(() => { (marker as HTMLButtonElement).click() })
    expect(onFocusActiveWorktreeResolver).toHaveBeenCalledTimes(1)
    expect(onResolve).not.toHaveBeenCalled()
  })
  it('shows a bench conflict above a stale base', () => {
    render({
      entry: entry({ needsSync: true }),
      membership: member({ merge: 'conflicted', conflictPaths: ['x.ts'] }),
      order: 1,
    })

    expect(q(`worktree-bench-conflict-${BRANCH}`)).not.toBeNull()
    expect(q(`worktree-sync-${BRANCH}`)).toBeNull()
  })

  it('says `excluded` and `behind` in the words when the slot can show neither', () => {
    // The case the collapsed MemberStatus could not express at all: the record
    // held one word and the other two facts were destroyed at write time.
    render({
      membership: member({ enabled: false, pin: 'behind', merge: 'conflicted' }),
      order: 1,
    })

    expect(q(`worktree-bench-conflict-${BRANCH}`)).not.toBeNull()
    expect(q(`worktree-word-${BRANCH}-excluded`)).not.toBeNull()
    expect(q(`worktree-word-${BRANCH}-behind`)).not.toBeNull()
  })

  it('does not duplicate the stage into the line-1 gutter', () => {
    // The line-2 chip already shows it; a line-1 glyph would make every staged
    // row carry the same mark twice.
    render({ entry: entry({ stage: 'verified' }), membership: member(), order: 1 })

    expect(q(`worktree-review-good-${BRANCH}`)).toBeNull()
    // The chip is the single indicator, and it is present on line 2.
    expect(q(`worktree-stage-chip-${BRANCH}`)).not.toBeNull()
  })
})
