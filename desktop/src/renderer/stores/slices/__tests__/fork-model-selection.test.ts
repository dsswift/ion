import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({})),
  nextMsgId: vi.fn(() => 'fork-message-id'),
}))

import { forkModelSelection, createForkSlice } from '../resume-slice-fork'

function buildForkHarness(engineProfileId: string | null) {
  const state: Record<string, any> = {
    tabs: [{
      id: 'source-tab',
      title: 'Source',
      customTitle: null,
      conversationId: 'source-conversation',
      engineProfileId,
      workingDirectory: '/repo',
      hasChosenDirectory: true,
      additionalDirs: [],
      pillColor: null,
      pillIcon: null,
    }],
    conversationPanes: new Map([[
      'source-tab',
      {
        activeInstanceId: 'main',
        instances: [{
          id: 'main',
          messages: [{ id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 }],
          modelOverride: null,
          modelOverrideSource: null,
          permissionMode: 'auto',
          thinkingEffort: 'off',
        }],
      },
    ]]),
    activeTabId: 'source-tab',
    isExpanded: false,
  }
  const set = (partial: unknown): void => {
    const patch = typeof partial === 'function'
      ? (partial as (current: Record<string, any>) => Record<string, any>)(state)
      : partial
    Object.assign(state, patch)
  }
  const get = () => state
  const slice = createForkSlice(set as never, get as never)
  Object.assign(state, slice)
  return state
}

describe('forkModelSelection', () => {
  it('preserves model value and automatic provenance', () => {
    expect(forkModelSelection({ modelOverride: 'gpt-5.6-sol', modelOverrideSource: 'automatic' })).toEqual({
      modelOverride: 'gpt-5.6-sol', modelOverrideSource: 'automatic',
    })
  })

  it('preserves direct user selection provenance', () => {
    expect(forkModelSelection({ modelOverride: 'gpt-5.6-terra', modelOverrideSource: 'user' })).toEqual({
      modelOverride: 'gpt-5.6-terra', modelOverrideSource: 'user',
    })
  })
})

describe('forkFromMessage conversation kind preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).window = {
      ion: {
        createTab: vi.fn(async () => ({ tabId: 'fork-tab' })),
        engineFork: vi.fn(async () => ({ ok: true, newKey: 'fork-tab', conversationId: 'fork-conversation' })),
        engineBroadcastHistory: vi.fn(async () => undefined),
        reconcileCharts: vi.fn(),
        setPermissionMode: vi.fn(),
      },
    }
  })

  it('creates a durable fork whose identity is available before the first prompt', async () => {
    const state = buildForkHarness('extension-profile')

    await state.forkFromMessage('source-tab', 'user-1')

    const forked = state.tabs.find((tab: { id: string }) => tab.id === 'fork-tab')
    expect(forked).toMatchObject({
      conversationId: 'fork-conversation',
      lastKnownSessionId: 'fork-conversation',
      forkedFromSessionId: 'source-conversation',
    })
    expect(state.conversationPanes.get('fork-tab').instances[0]).toMatchObject({
      conversationIds: ['fork-conversation'],
      historyHydrated: true,
    })
    expect((window as any).ion.engineFork).toHaveBeenCalledWith('source-tab', 'fork-tab', {
      messageIndex: -1,
      entryId: 'user-1',
      userTurnIndex: 0,
    })
    expect((window as any).ion.engineBroadcastHistory).toHaveBeenCalledWith(
      'fork-tab', 'main', { queueUntilTabExists: true },
    )
  })

  it('keeps an extension profile on the forked tab', async () => {
    const state = buildForkHarness('extension-profile')

    await state.forkFromMessage('source-tab', 'user-1')

    expect(state.tabs.find((tab: { id: string }) => tab.id === 'fork-tab')?.engineProfileId).toBe('extension-profile')
  })

  it('keeps a Plain tab Plain', async () => {
    const state = buildForkHarness(null)

    await state.forkFromMessage('source-tab', 'user-1')

    expect(state.tabs.find((tab: { id: string }) => tab.id === 'fork-tab')?.engineProfileId).toBeNull()
  })
})
