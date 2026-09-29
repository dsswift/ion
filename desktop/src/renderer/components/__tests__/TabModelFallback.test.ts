/**
 * Tests for `resolveTabModelFallback` — the pure resolver that derives the
 * desktop model-fallback ⚠ indicator for a tab's active engine instance.
 *
 * Why this exists
 * ───────────────
 * The model-fallback ⚠ was previously rendered by `EngineTabStrip`, which was
 * deleted in the conversation-unification (#256) work. The `engineModelFallbacks`
 * state and its snapshot projection to iOS survived (iOS still renders the
 * indicator on its EngineInstanceBar — AGENTS.md parity table), but the desktop
 * lost its own render, breaking desktop↔iOS parity. The pill (TabStripTabPill)
 * now re-derives the indicator via `resolveTabModelFallback`. This test pins
 * the resolver so the desktop side cannot silently lose the indicator again.
 *
 * The resolver is pure (no React/DOM/Electron), so the node environment is
 * sufficient and the test is non-brittle: it pins the bare-tabId keying
 * contract, not incidental component internals.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }) },
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

import { resolveTabModelFallback, type TabModelFallback } from '../conversation-status'

const fb: TabModelFallback = {
  requestedModel: 'opus-9',
  fallbackModel: 'sonnet-default',
  reason: 'requested model not configured',
  at: 1_700_000_000_000,
}

// Minimal pane factory: one instance, active by default.
function paneFor(tabId: string, instanceId: string) {
  return new Map([
    [tabId, { activeInstanceId: instanceId, instances: [{ id: instanceId }] }],
  ]) as any
}

describe('resolveTabModelFallback', () => {
  it('returns the fallback keyed by bare tabId', () => {
    const panes = paneFor('tab-1', 'main')
    const fallbacks = new Map([['tab-1', fb]])

    expect(resolveTabModelFallback(panes, fallbacks, 'tab-1')).toEqual(fb)
  })

  it('returns null when no fallback is recorded for the tab', () => {
    const panes = paneFor('tab-1', 'main')
    const fallbacks = new Map<string, TabModelFallback>()

    expect(resolveTabModelFallback(panes, fallbacks, 'tab-1')).toBeNull()
  })

  it('returns null when the tab has no pane', () => {
    const fallbacks = new Map([['tab-1', fb]])

    expect(resolveTabModelFallback(new Map() as any, fallbacks, 'tab-1')).toBeNull()
  })

  it('returns null when the tab has no active instance', () => {
    // Pane exists but has no instances — resolver must guard and return null.
    const panes = new Map([
      ['tab-1', { activeInstanceId: undefined, instances: [] }],
    ]) as any
    const fallbacks = new Map([['tab-1', fb]])

    expect(resolveTabModelFallback(panes, fallbacks, 'tab-1')).toBeNull()
  })

  it('falls back to the first instance when activeInstanceId is unset', () => {
    const panes = new Map([
      ['tab-1', { activeInstanceId: undefined, instances: [{ id: 'main' }] }],
    ]) as any
    const fallbacks = new Map([['tab-1', fb]])

    expect(resolveTabModelFallback(panes, fallbacks, 'tab-1')).toEqual(fb)
  })
})
