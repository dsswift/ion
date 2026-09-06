/**
 * Pins the rule that the always-on status surfaces never animate.
 *
 * The status dots and the waiting-tab borders are on screen for the whole
 * session. An `infinite` CSS animation on any of them ticks the compositor on
 * every vsync of a high-refresh display for as long as the window exists, and
 * was measured keeping the GPU process and both renderers busy with the app
 * idle. The live state is now a static ring; a waiting pill is a solid border.
 * This test reads the stylesheet so the pulse cannot quietly return under any
 * name, and it checks the hidden-window gate still pauses whatever bounded
 * animations remain (spinners) without a hand-maintained class list.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const raw = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8')
// Comments may legitimately mention `infinite` while explaining why none exists.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

describe('index.css idle animations', () => {
  it('declares no infinite animation anywhere in the shared stylesheet', () => {
    expect(css).not.toMatch(/\binfinite\b/)
  })

  it('has no keyframes for the retired status pulses', () => {
    expect(css).not.toMatch(/@keyframes\s+(pulse-dot|border-pulse|bounce-dot)\b/)
    expect(css).not.toMatch(/\.animate-(pulse-dot|border-pulse|bounce-dot)\b/)
  })

  it('renders the live status ring without motion', () => {
    const rule = css.match(/\.ion-dot-live\s*\{([^}]*)\}/)
    expect(rule, '.ion-dot-live rule must exist').not.toBeNull()
    expect(rule![1]).toMatch(/outline:/)
    expect(rule![1]).not.toMatch(/animation|transition/)
  })

  it('pauses every animation in a hidden window, including inline shorthands', () => {
    const rule = css.match(/\.ion-window-hidden \*,\s*\.ion-window-hidden \*::before,\s*\.ion-window-hidden \*::after\s*\{([^}]*)\}/)
    expect(rule, 'universal hidden-window gate must exist').not.toBeNull()
    expect(rule![1]).toMatch(/animation-play-state:\s*paused\s*!important/)
  })
})
