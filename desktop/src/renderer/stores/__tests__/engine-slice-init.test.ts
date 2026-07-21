/**
 * engine-slice — single-instance lifecycle and session-start divider
 *
 * Pins the contract that calling addEngineInstance for a new tab seeds a
 * single "── Session started at <time> ──" system divider into the
 * instance's `messages` field in `conversationPanes`. This is the only
 * insertion site for the session-start divider; tab restoration (where
 * instances already exist) intentionally bypasses addEngineInstance so
 * persisted dividers are preserved without duplication.
 *
 * Also pins:
 *   - The single-instance guard: a second addEngineInstance call on the
 *     same tab returns the existing instance id (no-op, no second instance).
 *   - resetEngineInstance re-seeds the divider after wiping per-instance
 *     state, so the engine-instance reset path leaves the user with a
 *     clean scrollback that visibly marks the reset boundary.
 *   - resetEngineInstance is a no-op for unknown tab/instance pairs.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 8)}`),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      engineProfiles: [],
      engineDefaultModel: '',
      preferredModel: '',
      defaultBaseDirectory: '',
      tabGroupMode: 'off',
      tabGroups: [],
    }),
  },
}))

// addEngineInstance calls window.ion.engineStart (Electron preload bridge).
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = {
  engineStart: vi.fn().mockResolvedValue({ ok: true }),
  engineAbort: vi.fn().mockResolvedValue(undefined),
}
if (!(globalThis as any).crypto?.randomUUID) {
  ;(globalThis as any).crypto = (globalThis as any).crypto ?? {}
  ;(globalThis as any).crypto.randomUUID = () => `${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}-aaaa-bbbb-cccccccccccc`
}

import { createEngineSlice } from '../slices/engine-slice'
import type { State } from '../session-store-types'

function makeTab(id: string) {
  return {
    id,
    title: 'Engine',
    engineProfileId: 'test-profile',
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: null,
    status: 'idle',
    customTitle: null,
    pillColor: null,
  }
}

function buildHarness() {
  const state: any = {
    tabs: [makeTab('tab1'), makeTab('tab2')],
    conversationPanes: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    closeTab: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineSlice(set, get) as State
  return { state, slice }
}

/** Get an instance from conversationPanes by tabId + instanceId. */
function getInstance(state: any, tabId: string, instanceId: string) {
  const pane = state.conversationPanes.get(tabId)
  return pane?.instances.find((i: any) => i.id === instanceId)
}

describe('engine-slice — addEngineInstance seeds session-start divider', () => {
  it('inserts a "Session started" divider as the first message of a new instance', () => {
    const { state, slice } = buildHarness()
    const instanceId = slice.addEngineInstance!('tab1')

    expect(instanceId).toBeTruthy()
    const inst = getInstance(state, 'tab1', instanceId)
    const msgs = inst?.messages ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Session started at /)
  })

  it('seeds a separate divider for each tab/instance pair', () => {
    const { state, slice } = buildHarness()

    const inst1 = slice.addEngineInstance!('tab1')
    const inst2 = slice.addEngineInstance!('tab2')

    const msgs1 = getInstance(state, 'tab1', inst1)?.messages ?? []
    const msgs2 = getInstance(state, 'tab2', inst2)?.messages ?? []
    expect(msgs1.length).toBe(1)
    expect(msgs2.length).toBe(1)
    // Distinct message ids so the dividers are not silently de-duped by
    // the renderer's list-item keying.
    expect(msgs1[0].id).not.toBe(msgs2[0].id)
  })

  it('passes pendingParentConversationId to engineStart as parentConversationId and clears it', () => {
    // Checkpoint cut (clear-context) wiring: the tab carries the prior id as
    // pendingParentConversationId; the next engine start forwards it so the
    // engine records the new conversation's on-disk parentId. (Commit 4.)
    const { state, slice } = buildHarness()
    ;((globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>).mockClear()
    state.tabs = state.tabs.map((t: any) =>
      t.id === 'tab1' ? { ...t, pendingParentConversationId: 'parent-conv-xyz' } : t
    )

    slice.addEngineInstance!('tab1')

    const startMock = (globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>
    const call = startMock.mock.calls.find((c: any[]) => c[0] === 'tab1')
    expect(call).toBeTruthy()
    expect(call![1].parentConversationId).toBe('parent-conv-xyz')
    // The one-shot transient is consumed.
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.pendingParentConversationId).toBeNull()
  })

  it('omits parentConversationId when no pending parent is set', () => {
    const { slice } = buildHarness()
    ;((globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>).mockClear()

    slice.addEngineInstance!('tab2')

    const startMock = (globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>
    const call = startMock.mock.calls.find((c: any[]) => c[0] === 'tab2')
    expect(call![1].parentConversationId).toBeUndefined()
  })
})

describe('engine-slice — resetEngineInstance', () => {
  it('wipes per-instance state and seeds a fresh Session-started divider', () => {
    const { state, slice } = buildHarness()
    const instanceId = slice.addEngineInstance!('tab1')

    // Append activity that resetEngineInstance must clear via pane mutation.
    const pane = state.conversationPanes.get('tab1')
    const idx = pane.instances.findIndex((i: any) => i.id === instanceId)
    pane.instances[idx] = {
      ...pane.instances[idx],
      messages: [
        ...(pane.instances[idx].messages || []),
        { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
        { id: 'a1', role: 'assistant', content: 'hi', timestamp: Date.now() },
      ],
      agentStates: [{ name: 'chief', status: 'idle' }],
      statusFields: { state: 'running' },
    }
    state.engineUsage.set('tab1', { percent: 5, tokens: 100, cost: 0.001 })

    slice.resetEngineInstance!('tab1', instanceId)

    // Instance messages: re-seeded with exactly one session-start divider.
    const inst = getInstance(state, 'tab1', instanceId)
    const msgs = inst?.messages ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Session started at /)

    // Instance fields zeroed.
    expect(inst?.agentStates).toEqual([])
    expect(inst?.statusFields).toBeNull()
    expect(inst?.permissionDenied).toBeNull()
    expect(inst?.conversationIds).toEqual([])

    // Non-ConversationInstance Maps cleaned up.
    expect(state.engineUsage.has('tab1')).toBe(false)

    // The instance pane entry itself is preserved.
    expect(state.conversationPanes.get('tab1')?.instances.some((i: any) => i.id === instanceId)).toBe(true)
  })

  it('is a no-op for an unknown tab', () => {
    const { state, slice } = buildHarness()
    expect(() => slice.resetEngineInstance!('nonexistent-tab', 'whatever')).not.toThrow()
    expect(state.conversationPanes.size).toBe(0)
  })

  it('is a no-op for an unknown instance under a known tab', () => {
    const { state, slice } = buildHarness()
    slice.addEngineInstance!('tab1')
    const panesBeforeSize = state.conversationPanes.get('tab1')?.instances.length ?? 0

    slice.resetEngineInstance!('tab1', 'inst-does-not-exist')

    // No new instances created, no existing ones wiped.
    expect(state.conversationPanes.get('tab1')?.instances.length ?? 0).toBe(panesBeforeSize)
  })
})

describe('engine-slice — single-instance guard (#256 phase 1)', () => {
  it('returns existing instance id when tab already has an instance (no second instance created)', () => {
    const { state, slice } = buildHarness()
    const firstId = slice.addEngineInstance!('tab1')
    expect(firstId).toBeTruthy()
    expect(state.conversationPanes.get('tab1')?.instances.length).toBe(1)

    // Second call: must return the existing id, not create a new instance.
    const secondId = slice.addEngineInstance!('tab1')
    expect(secondId).toBe(firstId)
    expect(state.conversationPanes.get('tab1')?.instances.length).toBe(1)
  })

  it('no multi-instance operations exist on the slice', () => {
    const { slice } = buildHarness()
    // These operations were removed in conversation unification #256 phase 1.
    // If any reappear, these assertions catch the regression.
    expect((slice as any).removeEngineInstance).toBeUndefined()
    expect((slice as any).selectEngineInstance).toBeUndefined()
    expect((slice as any).renameEngineInstance).toBeUndefined()
    expect((slice as any).moveEngineInstance).toBeUndefined()
    expect((slice as any).reorderEngineInstances).toBeUndefined()
  })
})

describe('engine-slice — session-limit rejection surfaces actionable message (D-007)', () => {
  it('shows "Maximum sessions reached" guidance when the engine rejects with the session-limit error', async () => {
    const { state, slice } = buildHarness()
    const startMock = (globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>
    startMock.mockClear()
    startMock.mockResolvedValueOnce({
      ok: false,
      error: 'session limit reached: enterprise policy allows a maximum of 3 concurrent sessions',
    })

    slice.addEngineInstance!('tab1')
    // Let the engineStart promise chain settle.
    await new Promise((r) => setTimeout(r, 0))

    const notifs = state.engineNotifications.get('tab1') ?? []
    expect(notifs.some((n: any) => n.message === 'Maximum sessions reached. Close a tab to open a new one.')).toBe(true)
    // The generic "Extension error" framing must NOT be used for this case.
    expect(notifs.some((n: any) => String(n.message).startsWith('Extension error'))).toBe(false)

    const inst = getInstance(state, 'tab1', 'main')
    expect(inst?.messages.some((m: any) => m.content === 'Maximum sessions reached. Close a tab to open a new one.')).toBe(true)
  })

  it('keeps the generic error framing for non-limit failures', async () => {
    const { state, slice } = buildHarness()
    const startMock = (globalThis as any).window.ion.engineStart as ReturnType<typeof vi.fn>
    startMock.mockClear()
    startMock.mockResolvedValueOnce({ ok: false, error: 'extension load failed: boom' })

    slice.addEngineInstance!('tab2')
    await new Promise((r) => setTimeout(r, 0))

    const notifs = state.engineNotifications.get('tab2') ?? []
    expect(notifs.some((n: any) => String(n.message).startsWith('Extension error'))).toBe(true)
  })
})
