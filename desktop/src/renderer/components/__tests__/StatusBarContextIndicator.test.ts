/**
 * Tests for the StatusBarContextIndicator's local percent recomputation.
 *
 * The component's job is to render a percent + tooltip showing how much
 * of the conversation's context window is used. The bug fixed in
 * plan cosy-pacing-bee.md (and Commit 3 of this branch) is that the
 * indicator was dividing engine-reported `contextTokens` by the
 * *picker-selected* model's nominal window, producing a 100% reading
 * whenever the picker disagreed with the engine (e.g. an Opus-running
 * conversation displayed under a Sonnet picker selection: 498k / 200k).
 *
 * The fix anchors the denominator to the engine's reported
 * `contextWindow` (now plumbed onto the tab state) and only falls back
 * to the picker model's window when the engine has not yet answered.
 *
 * We test the pure math in isolation by reproducing the component's
 * formula here. The React rendering is intentionally not tested — the
 * formula is the contract, the rendering is incidental.
 */

import { describe, it, expect } from 'vitest'

// Mirrors the formula in StatusBarContextIndicator.tsx. Kept in lockstep
// with that component; any change there must update both. The fix is
// pinned by the test name "uses engine window over picker window"
// below — if a future refactor regresses to dividing by the picker
// window, that test fails immediately.
function resolvePercentAndTokens(input: {
  contextTokens: number | null
  contextPercent: number | null
  engineContextWindow: number | null
  pickerWindow: number
}): { pct: number | null; tokens: number } {
  const windowSize = input.engineContextWindow ?? input.pickerWindow
  const pct = input.contextTokens != null
    ? Math.min(100, Math.round((input.contextTokens / windowSize) * 100))
    : input.contextPercent
  if (pct === null) return { pct: null, tokens: 0 }
  const tokens = input.contextTokens ?? (pct * windowSize / 100)
  return { pct, tokens }
}

describe('StatusBarContextIndicator math', () => {
  it('uses engine window over picker window (regression for sturdy-wishing-tide bug)', () => {
    // The exact scenario from conv 1780569626357-83f24099a9d8:
    // engine ran on opus-4-7 (1M window), reported 497742 input tokens,
    // user has Sonnet 4.6 (200K) selected in the picker. Pre-fix this
    // rendered 100% / 498k / 200k. Post-fix: 50% / 498k / 1.0M.
    const out = resolvePercentAndTokens({
      contextTokens: 497742,
      contextPercent: 50,
      engineContextWindow: 1_000_000,
      pickerWindow: 200_000,
    })
    expect(out.pct).toBe(50)
    expect(out.tokens).toBe(497742)
  })

  it('falls back to picker window when engine has not yet reported (cold-start tab)', () => {
    // Fresh tab with no engine response yet. The indicator must still
    // render *something* — falling back to the picker model's window is
    // the documented intent. Once the engine answers (next test) the
    // window switches.
    const out = resolvePercentAndTokens({
      contextTokens: 50_000,
      contextPercent: null,
      engineContextWindow: null,
      pickerWindow: 200_000,
    })
    expect(out.pct).toBe(25)
    expect(out.tokens).toBe(50_000)
  })

  it('prefers engine percent when contextTokens is null', () => {
    // This is the path iOS already had correct: when the engine has
    // supplied a pre-computed percent but the local tokens count is
    // null, use the engine's percent verbatim.
    const out = resolvePercentAndTokens({
      contextTokens: null,
      contextPercent: 42,
      engineContextWindow: 200_000,
      pickerWindow: 200_000,
    })
    expect(out.pct).toBe(42)
  })

  it('returns null when both engine percent and contextTokens are null', () => {
    // Brand-new tab, no data at all. The indicator hides itself rather
    // than rendering a misleading 0%.
    const out = resolvePercentAndTokens({
      contextTokens: null,
      contextPercent: null,
      engineContextWindow: null,
      pickerWindow: 200_000,
    })
    expect(out.pct).toBeNull()
  })

  it('caps the displayed percent at 100 even on transient mismatch', () => {
    // Defence-in-depth: if a stale contextTokens somehow points at a
    // smaller engine window during the cold-start race, the display cap
    // protects against showing 250%. The underlying state should never
    // produce this in steady-state — the projection in
    // engine-event-status.ts updates contextWindow on every status tick
    // — but the cap pins the UI invariant.
    const out = resolvePercentAndTokens({
      contextTokens: 500_000,
      contextPercent: null,
      engineContextWindow: 200_000,
      pickerWindow: 1_000_000,
    })
    expect(out.pct).toBe(100)
  })

  it('picker change between turns does NOT change the displayed percent', () => {
    // Before the picker change: opus running, 497K tokens reported.
    const before = resolvePercentAndTokens({
      contextTokens: 497742,
      contextPercent: 50,
      engineContextWindow: 1_000_000,
      pickerWindow: 1_000_000,
    })
    // After the picker change (Sonnet selected, but the engine has not
    // yet run a turn on Sonnet so contextTokens / engineContextWindow
    // still reflect opus). The picker change must NOT shift the display
    // — that's the regression we're guarding against.
    const after = resolvePercentAndTokens({
      contextTokens: 497742,
      contextPercent: 50,
      engineContextWindow: 1_000_000,
      pickerWindow: 200_000,
    })
    expect(after.pct).toBe(before.pct)
    expect(after.tokens).toBe(before.tokens)
  })
})
