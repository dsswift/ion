/**
 * engine-event-slice — engine_status.permissionDenials → enginePermissionDenied
 *
 * The engine intercepts AskUserQuestion and ExitPlanMode and emits the
 * denial on the next engine_status event under `fields.permissionDenials`.
 * For engine-view tabs (compound `tabId:instanceId` key), the slice
 * translates this signal into the renderer's
 * `enginePermissionDenied` map (keyed by the FULL compound key) — the
 * CLI synthesis path in engine-control-plane-events.ts:handleStatusEvent
 * is bypassed for these tabs because EngineControlPlane is keyed by
 * bare tabId only.
 *
 * Contract pinned here:
 *   1. AskUserQuestion / ExitPlanMode denials populate
 *      `enginePermissionDenied.get(compoundKey)`.
 *   2. Other denial tool names are ignored.
 *   3. Cost-only follow-up status (no denials) preserves the existing
 *      entry — it does NOT clobber.
 *   4. Two compound keys under the same parent tabId track INDEPENDENT
 *      denials. Sibling instances don't share a card.
 *   5. The parent `tab.permissionDenied` is NOT mutated by this slice
 *      for engine paths — that field is CLI-only.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', isEngine: true, lastEventAt: 0, status: 'running', permissionDenied: null }],
    engineAgentStates: new Map(),
    engineStatusFields: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineMessages: new Map(),
    engineDraftInputs: new Map(),
    engineModelOverrides: new Map(),
    engineConversationIds: new Map(),
    enginePanes: new Map(),
    enginePermissionDenied: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

describe('engine_status.permissionDenials → enginePermissionDenied', () => {
  it('sets enginePermissionDenied for AskUserQuestion denial on compound key', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        permissionDenials: [
          {
            toolName: 'AskUserQuestion',
            toolUseId: 'tu-1',
            toolInput: { question: 'Pick one', options: ['A', 'B'] },
          },
        ],
      },
    } as any)

    const entry = state.enginePermissionDenied.get(key)
    expect(entry).not.toBeNull()
    expect(entry.tools).toHaveLength(1)
    expect(entry.tools[0].toolName).toBe('AskUserQuestion')
    expect(entry.tools[0].toolUseId).toBe('tu-1')
    expect(entry.tools[0].toolInput).toEqual({ question: 'Pick one', options: ['A', 'B'] })
    // Parent tab's permissionDenied stays null — engine path no longer mutates it.
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.permissionDenied).toBeNull()
  })

  it('sets enginePermissionDenied for ExitPlanMode denial', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        permissionDenials: [
          {
            toolName: 'ExitPlanMode',
            toolUseId: 'tu-2',
            toolInput: { planFilePath: '/x/plan.md' },
          },
        ],
      },
    } as any)

    const entry = state.enginePermissionDenied.get(key)
    expect(entry?.tools[0].toolName).toBe('ExitPlanMode')
  })

  it('filters out non-interactive tool denials (Read, Bash, etc.)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'Read', toolUseId: 'tu-3', toolInput: { file_path: '/x' } },
          { toolName: 'Bash', toolUseId: 'tu-4', toolInput: { command: 'ls' } },
        ],
      },
    } as any)

    // No AskUserQuestion / ExitPlanMode denials → map entry stays absent.
    expect(state.enginePermissionDenied.get(key)).toBeUndefined()
  })

  it('preserves existing enginePermissionDenied on follow-up cost-only status (no denials)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'

    // Tick 1: denial arrives.
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } },
        ],
      },
    } as any)

    // Tick 2: cost-only follow-up (engine emits this ~1ms after the denial tick).
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        totalCostUsd: 0.001,
        // permissionDenials absent
      },
    } as any)

    const entry = state.enginePermissionDenied.get(key)
    expect(entry).not.toBeUndefined()
    expect(entry.tools[0].toolName).toBe('AskUserQuestion')
  })

  it('isolates sibling instances under the same parent tabId', () => {
    const { state, slice } = buildHarness()
    const keyA = 'tab1:inst-a'
    const keyB = 'tab1:inst-b'

    // Instance A: AskUserQuestion denial.
    slice.handleEngineEvent(keyA, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 0,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'tu-a', toolInput: { question: 'A?' } },
        ],
      },
    } as any)

    // Instance B: ExitPlanMode denial. Distinct compound key under the
    // same parent tab.
    slice.handleEngineEvent(keyB, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 0,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'ExitPlanMode', toolUseId: 'tu-b', toolInput: { planFilePath: '/p.md' } },
        ],
      },
    } as any)

    const entryA = state.enginePermissionDenied.get(keyA)
    const entryB = state.enginePermissionDenied.get(keyB)
    expect(entryA?.tools[0].toolName).toBe('AskUserQuestion')
    expect(entryB?.tools[0].toolName).toBe('ExitPlanMode')
    // Crucially, the two entries are independent — clearing one must
    // not affect the other.
  })

  it('ignores engine_status on bare (non-compound) keys', () => {
    const { state, slice } = buildHarness()

    // Bare tabId — handler should return early via the !key.includes(':') guard.
    slice.handleEngineEvent('tab1', {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 0,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } },
        ],
      },
    } as any)

    // Neither the bare key nor any compound key receives an entry.
    expect(state.enginePermissionDenied.get('tab1')).toBeUndefined()
    expect(state.enginePermissionDenied.size).toBe(0)
    // Parent tab's permissionDenied also stays null.
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.permissionDenied).toBeNull()
  })
})
