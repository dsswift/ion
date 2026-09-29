import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fork starts from a live source session. A conversation restored after a
 * server restart has none until its first prompt, so the fork wakes it first,
 * and a fork that still fails says so in the source conversation instead of
 * doing nothing.
 */

vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({})),
  nextMsgId: vi.fn(() => 'fork-message-id'),
}))

vi.mock('../../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({ engineProfiles: [{ id: 'extension-profile', extensions: ['/ext/harness'] }] }) },
}))

const calls: string[] = []
const mockEnsureEngineSession = vi.fn()
const mockCreateTab = vi.fn()
const mockEngineFork = vi.fn()
const mockCloseTab = vi.fn()

vi.mock('../../host-api', () => ({
  ensureEngineSession: (...args: unknown[]) => { calls.push('ensure'); return mockEnsureEngineSession(...args) },
  createTab: (...args: unknown[]) => { calls.push('create'); return mockCreateTab(...args) },
  engineFork: (...args: unknown[]) => { calls.push('fork'); return mockEngineFork(...args) },
  closeTab: (...args: unknown[]) => mockCloseTab(...args),
  engineBroadcastHistory: vi.fn(async () => undefined),
  setPermissionMode: vi.fn(),
}))

import { createForkSlice } from '../resume-slice-fork'

interface Harness {
  tabs: Array<{ id: string }>
  conversationPanes: Map<string, { instances: Array<{ messages: Array<{ role: string; content: string }> }> }>
  forkTab: (tabId: string) => Promise<string | null>
  forkFromMessage: (tabId: string, messageId: string) => Promise<string | null>
}

function buildHarness(): Harness {
  const state: Record<string, unknown> = {
    tabs: [{
      id: 'source-tab',
      title: 'Source',
      customTitle: null,
      conversationId: 'source-conversation',
      engineProfileId: 'extension-profile',
      workingDirectory: '/repo',
      hasChosenDirectory: true,
      additionalDirs: [],
      pillColor: null,
    }],
    conversationPanes: new Map([[
      'source-tab',
      {
        activeInstanceId: 'main',
        instances: [{
          id: 'main',
          messages: [{ id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 }],
          permissionMode: 'plan',
          thinkingEffort: 'off',
        }],
      },
    ]]),
    activeTabId: 'source-tab',
  }
  const set = (partial: unknown): void => {
    const patch = typeof partial === 'function'
      ? (partial as (current: Record<string, unknown>) => Record<string, unknown>)(state)
      : partial
    Object.assign(state, patch)
  }
  Object.assign(state, createForkSlice(set as never, (() => state) as never))
  return state as unknown as Harness
}

function sourceMessages(state: Harness): Array<{ role: string; content: string }> {
  return state.conversationPanes.get('source-tab')?.instances[0].messages ?? []
}

describe('fork wakes a restored source conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    mockEnsureEngineSession.mockResolvedValue({ ok: true })
    mockCreateTab.mockResolvedValue({ tabId: 'fork-tab' })
    mockEngineFork.mockResolvedValue({ ok: true, conversationId: 'fork-conversation' })
    mockCloseTab.mockResolvedValue(undefined)
  })

  it.each(['forkTab', 'forkFromMessage'] as const)('%s starts the source session with its extensions before forking', async (verb) => {
    const state = buildHarness()

    const result = verb === 'forkTab' ? await state.forkTab('source-tab') : await state.forkFromMessage('source-tab', 'user-1')

    expect(result).toBe('fork-tab')
    expect(mockEnsureEngineSession).toHaveBeenCalledWith({
      tabId: 'source-tab',
      workingDirectory: '/repo',
      conversationId: 'source-conversation',
      permissionMode: 'plan',
      extensions: ['/ext/harness'],
    })
    expect(calls).toEqual(['ensure', 'create', 'fork'])
  })

  it('reports a source that cannot start and registers no tab', async () => {
    mockEnsureEngineSession.mockResolvedValue({ ok: false, error: 'engine offline' })
    const state = buildHarness()

    expect(await state.forkTab('source-tab')).toBeNull()

    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(sourceMessages(state).at(-1)).toMatchObject({
      role: 'system',
      content: 'Fork failed: The source conversation could not be started: engine offline',
    })
  })

  it('closes the registered tab and reports it when the engine refuses the fork', async () => {
    mockEngineFork.mockResolvedValue({ ok: false, error: 'Source conversation is not ready to fork' })
    const state = buildHarness()

    expect(await state.forkFromMessage('source-tab', 'user-1')).toBeNull()

    expect(mockCloseTab).toHaveBeenCalledWith('fork-tab')
    expect(state.tabs.map((tab) => tab.id)).toEqual(['source-tab'])
    expect(sourceMessages(state).at(-1)).toMatchObject({
      role: 'system',
      content: 'Fork failed: Source conversation is not ready to fork',
    })
  })
})
