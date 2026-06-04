/**
 * engine-slice — Session-started divider seeded by addEngineInstance
 *
 * Pins the contract that calling addEngineInstance for a new tab/instance
 * seeds a single "── Session started at <time> ──" system divider into
 * engineMessages[`${tabId}:${instanceId}`]. This is the only insertion
 * site for the session-start divider; tab restoration (where instances
 * already exist) intentionally bypasses addEngineInstance so persisted
 * dividers are preserved without duplication.
 *
 * Also pins:
 *   - resetEngineInstance re-seeds the divider after wiping per-instance
 *     state, so the engine-instance reset path (used by iOS "Implement,
 *     clear context" on engine tabs) leaves the user with a clean
 *     scrollback that visibly marks the reset boundary.
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
// In the vitest jsdom environment we shim it so the test does not hit IPC.
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = {
  engineStart: vi.fn().mockResolvedValue({ ok: true }),
  engineAbort: vi.fn().mockResolvedValue(undefined),
}
// crypto.randomUUID is available in node 19+ and jsdom; provide a fallback
// for environments where it is missing so the slice's UUID generation works.
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
    isEngine: true,
    engineProfileId: null,
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
    enginePanes: new Map(),
    engineMessages: new Map(),
    engineAgentStates: new Map(),
    engineStatusFields: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineDraftInputs: new Map(),
    engineModelOverrides: new Map(),
    engineConversationIds: new Map(),
    enginePermissionDenied: new Map(),
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

describe('engine-slice — addEngineInstance seeds session-start divider', () => {
  it('inserts a "Session started" divider as the first message of a new instance', () => {
    const { state, slice } = buildHarness()
    const instanceId = slice.addEngineInstance!('tab1')

    expect(instanceId).toBeTruthy()
    const key = `tab1:${instanceId}`
    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Session started at /)
  })

  it('seeds a separate divider for each tab/instance pair', () => {
    const { state, slice } = buildHarness()

    const inst1 = slice.addEngineInstance!('tab1')
    const inst2 = slice.addEngineInstance!('tab2')

    const msgs1 = state.engineMessages.get(`tab1:${inst1}`) ?? []
    const msgs2 = state.engineMessages.get(`tab2:${inst2}`) ?? []
    expect(msgs1.length).toBe(1)
    expect(msgs2.length).toBe(1)
    // Distinct message ids so the dividers are not silently de-duped by
    // the renderer's list-item keying.
    expect(msgs1[0].id).not.toBe(msgs2[0].id)
  })
})

describe('engine-slice — resetEngineInstance', () => {
  it('wipes per-instance state and seeds a fresh Session-started divider', () => {
    // Set up an instance with simulated activity: a couple of user/assistant
    // messages, a status, an agent state. resetEngineInstance should drop
    // them all and re-seed the divider so the scrollback is visibly fresh.
    const { state, slice } = buildHarness()
    const instanceId = slice.addEngineInstance!('tab1')
    const key = `tab1:${instanceId}`

    // Append activity that resetEngineInstance must clear.
    state.engineMessages.set(key, [
      ...(state.engineMessages.get(key) ?? []),
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: Date.now() },
    ])
    state.engineAgentStates.set(key, [{ name: 'chief', status: 'idle' }])
    state.engineStatusFields.set(key, { state: 'running' })
    state.engineUsage.set(key, { percent: 5, tokens: 100, cost: 0.001 })

    slice.resetEngineInstance!('tab1', instanceId)

    // engineMessages: re-seeded with exactly one session-start divider.
    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Session started at /)

    // Other per-instance Maps wiped.
    expect(state.engineAgentStates.has(key)).toBe(false)
    expect(state.engineStatusFields.has(key)).toBe(false)
    expect(state.engineUsage.has(key)).toBe(false)

    // The instance pane entry itself is preserved — the user stays on
    // the same sub-tab. (Removal is the resetTabSession + closeTab path.)
    const pane = state.enginePanes.get('tab1')
    expect(pane?.instances.some((i: any) => i.id === instanceId)).toBe(true)
  })

  it('is a no-op for an unknown tab', () => {
    const { state, slice } = buildHarness()
    expect(() => slice.resetEngineInstance!('nonexistent-tab', 'whatever')).not.toThrow()
    expect(state.engineMessages.size).toBe(0)
  })

  it('is a no-op for an unknown instance under a known tab', () => {
    const { state, slice } = buildHarness()
    slice.addEngineInstance!('tab1')
    const beforeSize = state.engineMessages.size

    slice.resetEngineInstance!('tab1', 'inst-does-not-exist')

    // No new entries created, no existing ones wiped.
    expect(state.engineMessages.size).toBe(beforeSize)
  })
})
