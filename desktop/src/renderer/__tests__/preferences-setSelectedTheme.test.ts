/**
 * Regression test: setSelectedTheme must persist the selected theme to disk
 * immediately.
 *
 * Bug: setSelectedTheme wrote to localStorage and the Zustand store but never
 * called saveSettings, so settings.json always kept the last-saved theme (ion-dark
 * by default). On startup, loadPersistedSettings reads from disk and the
 * selectedTheme value from disk overwrote the correct localStorage value,
 * reverting the applied theme to the default on every restart.
 *
 * Fix: `persist(set, { selectedTheme: id })` was added to setSelectedTheme.
 * Originally this was `saveSettings(getAllSettings(get))` (the whole settings
 * snapshot); that shape was replaced 2026-09-16 because sending the whole
 * snapshot on every setter freezes every OTHER in-memory field into this
 * identity's server-side overlay too, permanently blocking that field's
 * environment default from ever reaching the user again (see persist()'s
 * doc comment in preferences-persist.ts). `persist()` sends only the
 * `{ selectedTheme: id }` patch that actually changed.
 *
 * Test design — STRUCTURAL GUARD: reads preferences.ts source and asserts that
 * the persist call is present inside setSelectedTheme's body. This goes red
 * the moment the persist call is removed. Mirrors the established pattern
 * in ConversationView-selector-stability.test.ts (structural source read), which
 * avoids the top-level document/window side effects that prevent importing
 * preferences.ts directly in a node test environment.
 *
 * Revert contract: remove `persist(set, { selectedTheme: id })` from
 * setSelectedTheme and this test fails immediately, catching the regression
 * before it reaches CI.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('setSelectedTheme — persistence guard (structural)', () => {
  const src = readFileSync(resolve(__dirname, '../preferences.ts'), 'utf8')

  // Locate setSelectedTheme's body. The function spans from "setSelectedTheme: (id) => {"
  // to the matching closing brace. We extract just that region for targeted assertions
  // so that saveSettings calls in OTHER setters don't give a false positive.
  function extractSetSelectedThemeBody(): string {
    const startMarker = 'setSelectedTheme: (id) => {'
    const start = src.indexOf(startMarker)
    if (start === -1) throw new Error('setSelectedTheme not found in preferences.ts')

    // Walk forward to find the balanced closing brace of the arrow function body.
    let depth = 0
    let i = start + startMarker.length - 1 // position of the opening '{'
    while (i < src.length) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
      i++
    }
    throw new Error('setSelectedTheme body never closed — malformed source?')
  }

  it('[STRUCTURAL] setSelectedTheme body contains a persist call', () => {
    // Goes red the instant persistence is removed from setSelectedTheme —
    // the regression that caused themes to revert on every app restart.
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('persist(')
  })

  it('[STRUCTURAL] persist call carries only the selectedTheme patch, not the whole snapshot', () => {
    // Pin the exact shape of the call: a trivial empty persist(set, {}) would
    // not satisfy the first assertion, and reverting to
    // saveSettings(getAllSettings(get)) -- sending every other in-memory
    // field along with it -- must also fail here.
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('persist(set, { selectedTheme: id })')
    expect(body).not.toContain('getAllSettings')
  })

  it('[STRUCTURAL] setSelectedTheme applies the selected theme by id', () => {
    // Theme selection is single-axis: the setter must apply the picked
    // theme's palette directly (behavioral coverage of the full contract
    // lives in preferences-theme-switch.test.ts).
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('applyTheme(id)')
  })
})
