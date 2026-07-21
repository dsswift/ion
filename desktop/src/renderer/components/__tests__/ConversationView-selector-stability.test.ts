/**
 * Regression test: ConversationView combined selector (agentStates +
 * dispatchTelemetry) must return a stable reference across store notifications
 * when the underlying instance data is unchanged.
 *
 * Root cause (#185): the selector returned a fresh object literal
 * `{ agentStates, dispatchTelemetry }` on every call. Zustand's getSnapshot
 * equality check uses Object.is on the selector's return value. A new object
 * every call always fails Object.is, so every store notification triggered a
 * re-render even when instance data was identical — "Maximum update depth
 * exceeded."
 *
 * Fix: wrap the selector in `useShallow` so Zustand performs a shallow-equality
 * comparison on the returned object's VALUES instead of comparing the wrapper
 * object by identity.
 *
 * Test design: `useShallow` wraps a raw selector and applies `shallow()` from
 * `zustand/vanilla/shallow` to decide whether to return the previous cached
 * result or a new one. We test the stability contract in two layers:
 *
 *   1. STRUCTURAL GUARD — reads ConversationView.tsx and asserts `useShallow`
 *      wraps the combined selector. Goes red the moment the import or the wrap
 *      is removed.
 *
 *   2. LOGIC TESTS — use `shallow` from the vanilla Zustand module directly to
 *      prove: (a) same array references → shallow-equal → same wrapper object
 *      (stable, no re-render), and (b) different arrays → not shallow-equal →
 *      new object (re-render correctly triggered).
 *
 * Revert contract: removing `useShallow` from the ConversationView selector
 * causes assertion (1) to fail immediately.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { shallow } from 'zustand/vanilla/shallow'

// Paths for structural guards (used by multiple describe blocks below).
const conversationViewSrc = readFileSync(
  resolve(__dirname, '../ConversationView.tsx'),
  'utf8',
)
const appSrc = readFileSync(
  resolve(__dirname, '../../App.tsx'),
  'utf8',
)

// ── Stable fallback constants (same as ConversationView module-level) ─────────

const EMPTY_AGENTS: any[] = []
const EMPTY_TELEMETRY: any[] = []

// ── Selector body: mirrors the lambda inside useShallow(...) in ConversationView ─

function runSelector(state: any, tabId: string) {
  const p = state.conversationPanes.get(tabId)
  const inst = p?.activeInstanceId
    ? p.instances.find((i: any) => i.id === p.activeInstanceId)
    : null
  return {
    agentStates: inst?.agentStates ?? EMPTY_AGENTS,
    dispatchTelemetry: inst?.dispatchTelemetry ?? EMPTY_TELEMETRY,
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────

function makeState(agentStates: any[], dispatchTelemetry: any[]) {
  const pane = {
    activeInstanceId: 'inst-1',
    instances: [{ id: 'inst-1', agentStates, dispatchTelemetry }],
  }
  return { conversationPanes: new Map([['tab-1', pane]]) }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConversationView selector — shallow stability (#185 regression)', () => {
  // ── 1. Structural guard ──────────────────────────────────────────────────────

  it('[STRUCTURAL] ConversationView uses useShallow for the agentStates/dispatchTelemetry selector', () => {
    // This test goes red the instant useShallow is removed from the selector.
    const src = conversationViewSrc

    // Import must be present.
    expect(src).toContain("import { useShallow } from 'zustand/shallow'")

    // The combined selector must be wrapped: useShallow(s => { ... agentStates ... dispatchTelemetry ... })
    // We check that useShallow appears adjacent to the agentStates/dispatchTelemetry destructure.
    expect(src).toMatch(/const \{ agentStates, dispatchTelemetry \} = useSessionStore\(useShallow\(/)
  })

  // ── 2. Logic: same instance data → shallow-equal → stable reference ──────────

  it('same array references are shallow-equal (useShallow returns prior cached result)', () => {
    const agents = [{ name: 'a', status: 'done' }]
    const telemetry = [{ agentId: 'a', dispatched: 1 }]
    const state = makeState(agents, telemetry)

    const first = runSelector(state, 'tab-1')
    const second = runSelector(state, 'tab-1')

    // The raw selector always creates a new wrapper object — Object.is fails.
    expect(first).not.toBe(second)

    // BUT the VALUES inside are the same references, so shallow() returns true.
    // This is what useShallow exploits: it returns `prev.current` when shallow
    // equality holds, making the getSnapshot result stable.
    expect(shallow(first, second)).toBe(true)
  })

  it('different agentStates arrays are NOT shallow-equal (re-render correctly triggered)', () => {
    const agentsV1 = [{ name: 'a', status: 'done' }]
    const agentsV2 = [{ name: 'a', status: 'running' }]
    const telemetry: any[] = []

    const first = runSelector(makeState(agentsV1, telemetry), 'tab-1')
    const second = runSelector(makeState(agentsV2, telemetry), 'tab-1')

    expect(shallow(first, second)).toBe(false)
  })

  it('EMPTY_AGENTS / EMPTY_TELEMETRY fallbacks are shallow-equal across calls (no-pane is stable)', () => {
    // When the pane is absent the selector returns the module-level fallback
    // references. shallow() on two results that both reference the same
    // EMPTY_AGENTS and EMPTY_TELEMETRY arrays returns true → stable.
    const state = { conversationPanes: new Map() }

    const first = runSelector(state, 'tab-1')
    const second = runSelector(state, 'tab-1')

    // Values are identical stable references (EMPTY_AGENTS, EMPTY_TELEMETRY).
    expect(first.agentStates).toBe(EMPTY_AGENTS)
    expect(first.dispatchTelemetry).toBe(EMPTY_TELEMETRY)
    expect(shallow(first, second)).toBe(true)
  })

  it('[DOCUMENTS BUG] bare selector without useShallow creates a new object even when values are identical', () => {
    // This test documents exactly what caused #185: even when the underlying
    // arrays are the same references, the raw object literal `{ ... }` is a
    // new allocation every call, so Object.is (Zustand's snapshot equality)
    // always returns false → render loop.
    const agents = [{ name: 'a', status: 'done' }]
    const telemetry: any[] = []
    const state = makeState(agents, telemetry)

    const first = runSelector(state, 'tab-1')
    const second = runSelector(state, 'tab-1')

    // Without useShallow Zustand calls Object.is(first, second) → always false.
    expect(Object.is(first, second)).toBe(false)

    // useShallow fixes this by calling shallow(first, second) instead.
    expect(shallow(first, second)).toBe(true)
  })
})

// ─── Tab-switch reset guards ──────────────────────────────────────────────────
//
// Pins two structural fixes that reset ConversationView state on tab switch:
//
//   1. `useEffect(() => { setRenderOffset(0) }, [tabId])` — resets the
//      pagination offset when tabId changes. Pre-fix the dep array was
//      [activeInstanceId], which only fired on engine-instance change; switching
//      to a different tab with the same instance left renderOffset at a stale
//      non-zero value and showed a partial transcript on the new tab.
//
//   2. `key={activeTabId}` on <ConversationView> in App.tsx — forces React to
//      unmount/remount the component on tab switch, resetting all component
//      state (scroll position, search state, etc.) to initial values.
//
// Revert contract: restoring [activeInstanceId] or removing key={activeTabId}
// causes the corresponding assertion to fail immediately.

describe('ConversationView tab-switch reset — structural guards', () => {
  it('[STRUCTURAL] useEffect pagination reset uses [tabId] dep array (not [activeInstanceId])', () => {
    // This assertion goes red when the dep array is changed back to [activeInstanceId].
    // The comment "Reset pagination when switching engine instances" is intentionally
    // retained in source as documentation of the pre-fix intent; we only guard the
    // dep array value, not the comment.
    expect(conversationViewSrc).toContain('useEffect(() => { setRenderOffset(0) }, [tabId])')

    // Negative: the pre-fix dep array must no longer be present in the pagination reset.
    // (activeInstanceId is still used in OTHER useEffect deps in the file — we scope
    // the check to the setRenderOffset(0) line only by checking for the exact old form.)
    expect(conversationViewSrc).not.toContain('useEffect(() => { setRenderOffset(0) }, [activeInstanceId])')
  })

  it('[STRUCTURAL] App.tsx mounts ConversationView with key={activeTabId}', () => {
    // key={activeTabId} forces a full remount on tab switch, resetting scroll,
    // search state, and any other component-local state accumulated for the
    // previous tab. Reverting to no key (or a different key expression) causes
    // this assertion to fail.
    expect(appSrc).toContain('key={activeTabId}')

    // Scope: the key must appear on the ConversationView element specifically.
    expect(appSrc).toMatch(/<ConversationView key=\{activeTabId\}/)
  })
})

