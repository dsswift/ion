/**
 * engine-event-slice — engine_status.permissionDenials → instance.permissionDenied
 *
 * The engine intercepts AskUserQuestion and ExitPlanMode and emits the
 * denial on the next engine_status event under `fields.permissionDenials`.
 * For engine-view tabs (compound `tabId:instanceId` key), the slice
 * translates this signal into `instance.permissionDenied` on the matching
 * ConversationInstance in `conversationPanes` — keyed by the FULL compound key
 * split into tabId + instanceId. The CLI synthesis path in
 * engine-control-plane-events.ts:handleStatusEvent is bypassed for these
 * tabs because EngineControlPlane is keyed by bare tabId only.
 *
 * Contract pinned here:
 *   1. AskUserQuestion / ExitPlanMode denials populate instance.permissionDenied.
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

function makeInstance(id: string) {
  return { id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null, permissionMode: 'auto', permissionDenied: null, permissionQueue: [], conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null, forkedFromConversationIds: null }
}

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', hasEngineExtension: true, lastEventAt: 0, status: 'running', permissionDenied: null }],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', {
      instances: [makeInstance('inst-a'), makeInstance('inst-b'), makeInstance('inst1')],
      activeInstanceId: 'inst-a',
    }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

function getPermissionDenied(state: any, key: string) {
  const [tabId, instanceId] = key.split(':')
  const pane = state.conversationPanes.get(tabId)
  return pane?.instances.find((i: any) => i.id === instanceId)?.permissionDenied
}

describe('engine_status.permissionDenials → instance.permissionDenied', () => {
  it('sets instance.permissionDenied for AskUserQuestion denial on compound key', () => {
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

    const entry = getPermissionDenied(state, key)
    expect(entry).not.toBeNull()
    expect(entry.tools).toHaveLength(1)
    expect(entry.tools[0].toolName).toBe('AskUserQuestion')
    expect(entry.tools[0].toolUseId).toBe('tu-1')
    expect(entry.tools[0].toolInput).toEqual({ question: 'Pick one', options: ['A', 'B'] })
    // Parent tab's permissionDenied stays null — engine path no longer mutates it.
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.permissionDenied).toBeNull()
  })

  it('sets instance.permissionDenied for ExitPlanMode denial', () => {
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

    expect(getPermissionDenied(state, key)?.tools[0].toolName).toBe('ExitPlanMode')
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

    // No AskUserQuestion / ExitPlanMode denials → instance.permissionDenied stays null.
    expect(getPermissionDenied(state, key)).toBeNull()
  })

  it('preserves existing instance.permissionDenied on follow-up cost-only status (no denials)', () => {
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

    const entry = getPermissionDenied(state, key)
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

    // Instance B: ExitPlanMode denial.
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

    expect(getPermissionDenied(state, keyA)?.tools[0].toolName).toBe('AskUserQuestion')
    expect(getPermissionDenied(state, keyB)?.tools[0].toolName).toBe('ExitPlanMode')
    // Crucially, the two entries are independent.
  })

  it('ignores engine_status on bare (non-compound) keys', () => {
    const { state, slice } = buildHarness()

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

    // No instance in the pane received a denial.
    const pane = state.conversationPanes.get('tab1')
    for (const inst of pane.instances) {
      expect(inst.permissionDenied).toBeNull()
    }
    // Parent tab's permissionDenied also stays null.
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.permissionDenied).toBeNull()
  })
})

describe('engine_command_result clear → permissionDenied dismissed', () => {
  it('clears instance.permissionDenied on /clear for an engine tab and appends the divider', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'

    // First: an AskUserQuestion denial populates instance.permissionDenied.
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine',
        state: 'idle',
        model: 'sonnet',
        contextPercent: 12,
        contextWindow: 200000,
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'Pick one' } },
        ],
      },
    } as any)
    expect(getPermissionDenied(state, key)).not.toBeNull()

    const before = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst-a').messages.length

    // Then: /clear dismisses the card AND appends the clear divider.
    slice.handleEngineEvent(key, {
      type: 'engine_command_result',
      command: 'clear',
    } as any)

    expect(getPermissionDenied(state, key)).toBeNull()
    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst-a')
    expect(inst.messages.length).toBe(before + 1)
    expect(inst.messages[inst.messages.length - 1].role).toBe('system')

    // Sibling instance is untouched — only the addressed instance is cleared.
    const sibling = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst-b')
    expect(sibling.messages.length).toBe(0)
  })

  it('clears the main-instance permissionDenied on /clear for a CLI tab and appends the divider', () => {
    const { state, slice } = buildHarness()
    // Mark the CLI tab as carrying a pending card. Per-conversation denial
    // state lives on the tab's `main` instance now, so seed a main pane
    // carrying the pending denial.
    const cliTab = state.tabs.find((t: any) => t.id === 'tab1')
    cliTab.hasEngineExtension = false
    state.conversationPanes = new Map(state.conversationPanes)
    state.conversationPanes.set('tab1', {
      activeInstanceId: 'main',
      instances: [makeInstance('main')],
    })
    const mainInst = state.conversationPanes.get('tab1').instances[0]
    mainInst.permissionDenied = { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } }] }

    slice.handleEngineEvent('tab1', {
      type: 'engine_command_result',
      command: 'clear',
    } as any)

    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'main')
    expect(inst.permissionDenied).toBeNull()
    expect(inst.messages.length).toBe(1)
    expect(inst.messages[0].role).toBe('system')
  })

  it('does not clear permissionDenied when the clear command failed', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst-a'
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        label: 'engine', state: 'idle', model: 'sonnet', contextPercent: 0, contextWindow: 200000,
        permissionDenials: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } }],
      },
    } as any)
    expect(getPermissionDenied(state, key)).not.toBeNull()

    slice.handleEngineEvent(key, {
      type: 'engine_command_result',
      command: 'clear',
      commandError: 'boom',
    } as any)

    // Failed clear must not dismiss the card.
    expect(getPermissionDenied(state, key)).not.toBeNull()
  })
})
