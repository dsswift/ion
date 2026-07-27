/**
 * Pins the git panel's two layout invariants: conservation (every pixel is
 * assigned to a section, so no `flex: 1` child can absorb slack into a dead
 * band) and shrink-wrap (collapsing both split sections lowers the panel's
 * natural height instead of leaving a void at the bottom).
 *
 * The pre-fix inline arithmetic in `GitPanel.tsx` violated both: it hard-set the
 * container to `maxHeight` in every state and left the split pool unassigned
 * when Changes and Graph were both collapsed.
 */
import { describe, it, expect } from 'vitest'
import {
  computeGitPanelLayout,
  PANEL_HEADER,
  SECTION_HEADER,
  DIVIDER,
  WORKTREES_BODY_MAX,
  INTEGRATION_BODY_MAX,
} from './gitPanelLayout'

/** Matches the non-expanded panel: bodyMaxHeight 400 + 82 of surrounding chrome. */
const MAX = 482
const RATIO = 0.4

function layout(over: Partial<Parameters<typeof computeGitPanelLayout>[0]> = {}) {
  return computeGitPanelLayout({
    maxHeight: MAX,
    changesOpen: true,
    graphOpen: true,
    worktreesOpen: true,
    integrationOpen: true,
    splitRatio: RATIO,
    ...over,
  })
}

const BOOLS = [true, false]

describe('computeGitPanelLayout', () => {
  it('shrinks the panel when both split sections are collapsed', () => {
    const l = layout({ changesOpen: false, graphOpen: false })

    expect(l.splitPool).toBe(0)
    expect(l.changesBody).toBe(0)
    expect(l.graphBody).toBe(0)
    // Chrome only counts the divider when both split sections are open.
    expect(l.chrome).toBe(PANEL_HEADER + SECTION_HEADER * 4)
    expect(l.height).toBe(l.chrome + WORKTREES_BODY_MAX + INTEGRATION_BODY_MAX)
    // The regression: the panel used to stay at MAX with the surplus parked in
    // two `flex: 1` sinks, which is the reported dead band.
    expect(l.height).toBeLessThan(MAX)
  })

  it('shrinks all the way to bare headers when every section is collapsed', () => {
    const l = layout({
      changesOpen: false, graphOpen: false, worktreesOpen: false, integrationOpen: false,
    })

    expect(l.height).toBe(PANEL_HEADER + SECTION_HEADER * 4)
    expect(l.nonSplitTotal).toBe(l.height)
  })

  it('assigns every pixel in all 16 open/closed permutations', () => {
    for (const changesOpen of BOOLS) {
      for (const graphOpen of BOOLS) {
        for (const worktreesOpen of BOOLS) {
          for (const integrationOpen of BOOLS) {
            const l = layout({ changesOpen, graphOpen, worktreesOpen, integrationOpen })
            const label = `changes=${changesOpen} graph=${graphOpen} worktrees=${worktreesOpen} integration=${integrationOpen}`

            expect(
              l.chrome + l.worktreesBody + l.integrationBody + l.changesBody + l.graphBody,
              label,
            ).toBe(l.height)
            expect(l.changesBody + l.graphBody, label).toBe(l.splitPool)
            expect(l.height, label).toBeLessThanOrEqual(MAX)
            for (const v of [l.changesBody, l.graphBody, l.worktreesBody, l.integrationBody, l.splitPool]) {
              expect(v, label).toBeGreaterThanOrEqual(0)
            }
          }
        }
      }
    }
  })

  it('divides the pool by the split ratio when both split sections are open', () => {
    const l = layout()

    expect(l.dividerVisible).toBe(true)
    expect(l.chrome).toBe(PANEL_HEADER + SECTION_HEADER * 4 + DIVIDER)
    expect(l.splitPool).toBe(MAX - l.chrome - WORKTREES_BODY_MAX - INTEGRATION_BODY_MAX)
    expect(l.changesBody).toBe(Math.round(l.splitPool * RATIO))
    expect(l.changesBody + l.graphBody).toBe(l.splitPool)
    expect(l.height).toBe(MAX)
  })

  it('gives the whole pool to Changes when only Changes is open', () => {
    const l = layout({ graphOpen: false })

    expect(l.dividerVisible).toBe(false)
    expect(l.graphBody).toBe(0)
    expect(l.changesBody).toBe(l.splitPool)
    expect(l.height).toBe(MAX)
  })

  it('gives the whole pool to Graph when only Graph is open', () => {
    const l = layout({ changesOpen: false })

    expect(l.dividerVisible).toBe(false)
    expect(l.changesBody).toBe(0)
    expect(l.graphBody).toBe(l.splitPool)
    expect(l.height).toBe(MAX)
  })

  it('reclaims the divider row structurally when one split section closes', () => {
    const both = layout()
    const onlyChanges = layout({ graphOpen: false })

    expect(onlyChanges.splitPool).toBe(both.splitPool + DIVIDER)
  })

  it('reports nonSplitTotal as everything outside the split pool', () => {
    const open = layout()
    expect(open.nonSplitTotal).toBe(MAX - open.splitPool)
    expect(open.nonSplitTotal).toBe(open.chrome + WORKTREES_BODY_MAX + INTEGRATION_BODY_MAX)

    const collapsedFixed = layout({ worktreesOpen: false, integrationOpen: false })
    expect(collapsedFixed.nonSplitTotal).toBe(MAX - collapsedFixed.splitPool)
    expect(collapsedFixed.nonSplitTotal).toBe(collapsedFixed.chrome)
  })

  it('grows the split pool by the freed body when a fixed section collapses', () => {
    const all = layout()
    const noWorktrees = layout({ worktreesOpen: false })

    expect(noWorktrees.splitPool).toBe(all.splitPool + WORKTREES_BODY_MAX)
    expect(noWorktrees.worktreesBody).toBe(0)
    expect(noWorktrees.height).toBe(MAX)
  })

  it('clamps to a zero pool without negative bodies when maxHeight is too small', () => {
    const l = computeGitPanelLayout({
      maxHeight: 40,
      changesOpen: true,
      graphOpen: true,
      worktreesOpen: true,
      integrationOpen: true,
      splitRatio: RATIO,
    })

    expect(l.splitPool).toBe(0)
    expect(l.changesBody).toBe(0)
    expect(l.graphBody).toBe(0)
    expect(l.height).toBe(l.nonSplitTotal)
  })
})
