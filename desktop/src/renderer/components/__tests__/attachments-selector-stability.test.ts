/**
 * selectAttachmentsData — snapshot stability (React #185 regression).
 *
 * The AttachmentsButton selector must return only store-held references and
 * scalars: zustand's useShallow compares the returned object's VALUES with
 * Object.is, so any freshly built array (the old
 * `Object.values(resources).flat().filter(...)` and the `?? []` literals)
 * makes every getSnapshot call produce a new snapshot. React then treats the
 * snapshot as perpetually changed and throws #185 ("maximum update depth
 * exceeded") — abandoning the StatusBar subtree mid-render, which is exactly
 * the half-painted ATV/overlay status bar. This test calls the selector
 * twice with the SAME state and asserts zustand-shallow equality — it fails
 * on the pre-fix selector.
 */
import { describe, it, expect, vi } from 'vitest'
import { shallow } from 'zustand/shallow'

// The component module pulls the full renderer world at import time
// (preferences → settings IPC, theme tokens → document). Stub the heavy
// module-side-effect imports; the selector under test touches none of them.
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(), setState: vi.fn(), subscribe: vi.fn() }),
}))

import { selectAttachmentsData } from '../StatusBarAttachmentsButton'
import { makeMainPane } from '../../stores/conversation-instance'
import type { ResourceItem } from '../../../shared/types-engine'

function makeState(withResources: boolean) {
  const resource = {
    id: 'r1',
    kind: 'briefing',
    conversationId: 'conv-1',
  } as unknown as ResourceItem
  const resources: Record<string, ResourceItem[]> = withResources ? { briefing: [resource] } : {}
  return {
    tabs: [{ id: 'tab-1', conversationId: 'conv-1', workingDirectory: '/w' }],
    activeTabId: 'tab-1',
    conversationPanes: new Map([['tab-1', makeMainPane({})]]),
    resources,
  }
}

describe('selectAttachmentsData snapshot stability', () => {
  it('two calls with the same state are zustand-shallow equal (with resources)', () => {
    const state = makeState(true)
    const a = selectAttachmentsData(state)
    const b = selectAttachmentsData(state)
    expect(shallow(a, b)).toBe(true)
  })

  it('two calls with the same state are zustand-shallow equal (empty fallbacks)', () => {
    // Pane missing → messages fall back; must be the SAME empty reference
    // both times, not a fresh [] per call.
    const state = { ...makeState(false), conversationPanes: new Map() }
    const a = selectAttachmentsData(state)
    const b = selectAttachmentsData(state)
    expect(shallow(a, b)).toBe(true)
    expect(a.messages).toBe(b.messages)
  })

  it('returns only store-held references (no derived arrays in the snapshot)', () => {
    const state = makeState(true)
    const snap = selectAttachmentsData(state)
    expect(snap.resources).toBe(state.resources)
    expect(snap.messages).toBe(state.conversationPanes.get('tab-1')!.instances[0].messages)
  })
})
