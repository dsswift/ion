// @vitest-environment jsdom
//
// MergeEditor — the per-side interaction (the JetBrains shape).
//
// The defect these pin: the first版 editor offered only whole-chunk choices and
// the operator could not pick which side's hunks joined the result, nor see
// where each result line came from. Pinned here:
//   - accept/exclude controls exist per changed side of a chunk;
//   - a conflict resolves only when BOTH sides are decided, and the result
//     pane recomposes live with provenance-colored lines;
//   - Save is disabled until every conflict is decided.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel' }, children),
}))
vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}))

import { MergeEditor } from '../MergeEditor'

const DIR = '/wt/proj-a1'
const gitConflictStages = vi.fn()
const gitResolveConflict = vi.fn()
const gitConflictAccept = vi.fn()

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(onResolved = (): void => {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(MergeEditor, {
      directory: DIR, path: 'shared.txt', onClose: () => {}, onResolved,
    }))
  })
}

function click(testid: string): Promise<void> {
  return act(async () => {
    const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null
    if (!el) throw new Error(`missing ${testid}`)
    el.click()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { ion: Record<string, unknown> }).ion = {
    gitConflictStages, gitResolveConflict, gitConflictAccept,
  }
  // base line2 contested: ours says OURS, theirs says THEIRS.
  gitConflictStages.mockResolvedValue({
    ok: true,
    base: 'line1\nline2\nline3\n',
    ours: 'line1\nOURS\nline3\n',
    theirs: 'line1\nTHEIRS\nline3\n',
    oursLabel: 'base (abc1234)',
    theirsLabel: 'wt/proj-a1',
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Index of the conflict chunk in this fixture: [same(line1), conflict, same(line3)]. */
const CONFLICT = 1

describe('MergeEditor — per-side accept/exclude', () => {
  it('renders accept and exclude controls for both sides of a conflict', async () => {
    await render()
    expect(host.querySelector(`[data-testid="merge-accept-ours-${CONFLICT}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="merge-exclude-ours-${CONFLICT}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="merge-accept-theirs-${CONFLICT}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="merge-exclude-theirs-${CONFLICT}"]`)).not.toBeNull()
  })

  it('keeps Save disabled until both sides of the conflict are decided', async () => {
    await render()
    const save = (): HTMLButtonElement => host.querySelector('[data-testid="merge-save"]') as HTMLButtonElement
    expect(save().disabled).toBe(true)
    // The result pane holds the space with the unresolved marker.
    expect(host.querySelector(`[data-testid="merge-result-pending-${CONFLICT}"]`)).not.toBeNull()

    await click(`merge-accept-ours-${CONFLICT}`)
    expect(save().disabled).toBe(true) // theirs still pending

    await click(`merge-exclude-theirs-${CONFLICT}`)
    expect(save().disabled).toBe(false)
    expect(host.querySelector(`[data-testid="merge-result-pending-${CONFLICT}"]`)).toBeNull()
  })

  it('composes both sides ours-then-theirs when both are accepted', async () => {
    const onResolved = vi.fn()
    await render(onResolved)
    await click(`merge-accept-ours-${CONFLICT}`)
    await click(`merge-accept-theirs-${CONFLICT}`)

    gitResolveConflict.mockResolvedValue({ ok: true })
    await click('merge-save')

    expect(gitResolveConflict).toHaveBeenCalledWith(DIR, 'shared.txt', 'line1\nOURS\nTHEIRS\nline3\n')
    expect(onResolved).toHaveBeenCalled()
  })

  it('reverts to the base when both sides are excluded', async () => {
    await render(vi.fn())
    await click(`merge-exclude-ours-${CONFLICT}`)
    await click(`merge-exclude-theirs-${CONFLICT}`)
    gitResolveConflict.mockResolvedValue({ ok: true })
    await click('merge-save')
    expect(gitResolveConflict).toHaveBeenCalledWith(DIR, 'shared.txt', 'line1\nline2\nline3\n')
  })

  it('bulk "all left" / "all right" decide every unresolved conflict', async () => {
    await render(vi.fn())
    await click('merge-take-all-theirs')
    gitResolveConflict.mockResolvedValue({ ok: true })
    await click('merge-save')
    expect(gitResolveConflict).toHaveBeenCalledWith(DIR, 'shared.txt', 'line1\nTHEIRS\nline3\n')
  })

  it('decisions are reversible before saving', async () => {
    await render(vi.fn())
    await click(`merge-accept-ours-${CONFLICT}`)
    await click(`merge-exclude-theirs-${CONFLICT}`)
    // Flip: actually wanted theirs, not ours.
    await click(`merge-exclude-ours-${CONFLICT}`)
    await click(`merge-accept-theirs-${CONFLICT}`)
    gitResolveConflict.mockResolvedValue({ ok: true })
    await click('merge-save')
    expect(gitResolveConflict).toHaveBeenCalledWith(DIR, 'shared.txt', 'line1\nTHEIRS\nline3\n')
  })
})

describe('MergeEditor — aligned rows in one scroller', () => {
  it('renders each chunk as ONE grid row holding ours, result, and theirs', async () => {
    // The alignment guarantee is structural: a chunk's three cells live in the
    // same row element inside the single scroll container, so they cannot
    // drift apart at any scroll position. Three synced scrollTops could not
    // promise this — the sides have different line counts per chunk.
    await render()

    const scroller = host.querySelector('[data-testid="merge-scroll"]')
    expect(scroller).not.toBeNull()

    // Fixture chunks: [same(line1), conflict(line2), same(line3)].
    for (let i = 0; i < 3; i++) {
      const row = host.querySelector(`[data-testid="merge-chunk-row-${i}"]`)
      expect(row, `row ${i}`).not.toBeNull()
      // The row is a 3-column grid…
      expect((row as HTMLElement).style.gridTemplateColumns).toBe('1fr 1fr 1fr')
      // …inside the shared scroller, not a per-pane one.
      expect(scroller!.contains(row)).toBe(true)
    }

    // The conflict row carries all three representations side by side: ours
    // content, the pending marker, theirs content.
    const conflictRow = host.querySelector(`[data-testid="merge-chunk-row-${CONFLICT}"]`)!
    expect(conflictRow.textContent).toContain('OURS')
    expect(conflictRow.textContent).toContain('THEIRS')
    expect(conflictRow.querySelector(`[data-testid="merge-result-pending-${CONFLICT}"]`)).not.toBeNull()
  })

  it('keeps no per-column scroll container (one scroller owns all three)', async () => {
    await render()
    // Any nested overflow:auto inside the scroller would reintroduce
    // independent scrolling and break the row alignment.
    const scroller = host.querySelector('[data-testid="merge-scroll"]') as HTMLElement
    const nested = Array.from(scroller.querySelectorAll('div'))
      .filter((d) => (d as HTMLElement).style.overflow === 'auto' || (d as HTMLElement).style.overflowY === 'auto')
    expect(nested).toHaveLength(0)
  })
})
