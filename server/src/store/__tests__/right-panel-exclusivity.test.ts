/**
 * right-panel-exclusivity — the git panel and the Status Drawer never share the
 * right edge.
 *
 * Both panels anchor to the right of the content column, so open together they
 * need ~740px of gutter and run off the side of a smaller display. The invariant
 * lives in the store rather than in the four components that trigger it, so this
 * tests the slice directly.
 *
 * Contract:
 *   (a) Opening the git panel closes the drawer.
 *   (b) Opening the drawer closes the git panel.
 *   (c) Closing either panel leaves the other untouched: exclusivity fires on
 *       open only, so a close never opens or force-closes its sibling.
 *
 * Revert check: (a) and (b) both fail against a slice whose toggles set only
 * their own flag -- which is exactly what shipped before this change.
 */

import { describe, it, expect } from 'vitest'

import { createExpandSlice } from '../slices/expand-slice'

// ─── Harness ──────────────────────────────────────────────────────────────────
//
// Plain set/get over an object, the same shape terminal-tall-suspend.test.ts
// uses. No Zustand, no React: the slice is pure state math.

function buildHarness(overrides: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    gitPanelOpen: false,
    statusDrawerOpen: false,
    ...overrides,
  }

  const set = (updater: unknown) => {
    const patch = typeof updater === 'function'
      ? (updater as (s: Record<string, unknown>) => Record<string, unknown>)(state)
      : updater
    Object.assign(state, patch)
  }
  const get = () => state

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createExpandSlice(set as any, get as any) as any

  return { state, slice }
}

// ─── (a) git panel displaces the drawer ───────────────────────────────────────

describe('opening the git panel closes the Status Drawer', () => {
  it('closes the drawer', () => {
    const { state, slice } = buildHarness({
      statusDrawerOpen: true,
    })

    slice.toggleGitPanel()

    expect(state.gitPanelOpen).toBe(true)
    expect(state.statusDrawerOpen).toBe(false)
    // Cleared, not carried: reopening the drawer later should not silently
    // re-select a dispatch the operator navigated away from.
  })

  it('opens normally when the drawer was already closed', () => {
    const { state, slice } = buildHarness()

    slice.toggleGitPanel()

    expect(state.gitPanelOpen).toBe(true)
    expect(state.statusDrawerOpen).toBe(false)
  })
})

// ─── (b) drawer displaces the git panel ───────────────────────────────────────

describe('opening the Status Drawer closes the git panel', () => {
  it('closes the git panel', () => {
    const { state, slice } = buildHarness({ gitPanelOpen: true })

    slice.toggleStatusDrawer()

    expect(state.statusDrawerOpen).toBe(true)
    expect(state.gitPanelOpen).toBe(false)
  })

  it('opens normally when the git panel was already closed', () => {
    const { state, slice } = buildHarness()

    slice.toggleStatusDrawer()

    expect(state.statusDrawerOpen).toBe(true)
    expect(state.gitPanelOpen).toBe(false)
  })
})

// ─── (c) closing is not exclusivity ───────────────────────────────────────────

describe('closing a panel says nothing about the other one', () => {
  it('toggling the git panel closed does not open the drawer', () => {
    const { state, slice } = buildHarness({ gitPanelOpen: true })

    slice.toggleGitPanel()

    expect(state.gitPanelOpen).toBe(false)
    expect(state.statusDrawerOpen).toBe(false)
  })

  it('toggling the drawer closed does not open the git panel', () => {
    const { state, slice } = buildHarness({ statusDrawerOpen: true })

    slice.toggleStatusDrawer()

    expect(state.statusDrawerOpen).toBe(false)
    expect(state.gitPanelOpen).toBe(false)
  })

  it('closeGitPanel leaves an open drawer alone', () => {
    // Reached on every working-directory change that turns out not to be a repo
    // (StatusBar). If that path closed the drawer too, a non-repo tab would
    // dismiss a drawer the operator just opened.
    const { state, slice } = buildHarness({
      gitPanelOpen: true,
      statusDrawerOpen: true,
    })

    slice.closeGitPanel()

    expect(state.gitPanelOpen).toBe(false)
    expect(state.statusDrawerOpen).toBe(true)
  })

  it('closeStatusDrawer leaves an open git panel alone', () => {
    const { state, slice } = buildHarness({
      gitPanelOpen: true,
      statusDrawerOpen: true,
    })

    slice.closeStatusDrawer()

    expect(state.statusDrawerOpen).toBe(false)
    expect(state.gitPanelOpen).toBe(true)
  })
})
