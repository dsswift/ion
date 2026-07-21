/**
 * Regression test: setSelectedTheme must call saveSettings so the selected
 * theme is persisted to disk immediately.
 *
 * Bug: setSelectedTheme wrote to localStorage and the Zustand store but never
 * called saveSettings, so settings.json always kept the last-saved theme (ion-dark
 * by default). On startup, loadPersistedSettings reads from disk and the
 * selectedTheme value from disk overwrote the correct localStorage value,
 * reverting the applied theme to the default on every restart.
 *
 * Fix: saveSettings(getAllSettings(get)) was added to setSelectedTheme.
 *
 * Test design — STRUCTURAL GUARD: reads preferences.ts source and asserts that
 * the saveSettings call is present inside setSelectedTheme's body. This goes red
 * the moment the saveSettings call is removed. Mirrors the established pattern
 * in ConversationView-selector-stability.test.ts (structural source read), which
 * avoids the top-level document/window side effects that prevent importing
 * preferences.ts directly in a node test environment.
 *
 * Revert contract: remove `saveSettings(getAllSettings(get))` from setSelectedTheme
 * and this test fails immediately, catching the regression before it reaches CI.
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

  it('[STRUCTURAL] setSelectedTheme body contains saveSettings call', () => {
    // Goes red the instant saveSettings is removed from setSelectedTheme —
    // the regression that caused themes to revert on every app restart.
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('saveSettings(')
  })

  it('[STRUCTURAL] saveSettings call uses getAllSettings(get) as argument', () => {
    // Pin the exact shape of the call so a trivial empty saveSettings('') would
    // not satisfy the first assertion.
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('saveSettings(getAllSettings(get))')
  })

  it('[STRUCTURAL] setSelectedTheme applies theme for forced-scheme themes (forcedColorScheme branch)', () => {
    // The fix also corrected the startup apply path. Guard that the forced-scheme
    // branch (applyTheme(id)) is present alongside the persist call.
    const body = extractSetSelectedThemeBody()
    expect(body).toContain('forcedColorScheme')
    expect(body).toContain('applyTheme(id)')
  })
})
