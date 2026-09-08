/**
 * submit() refuses a prompt while the conversation is being compacted.
 *
 * There is no way to steer a compaction in progress — it is not a turn a
 * queued prompt could interrupt or redirect — so a send during one is
 * refused outright by the same shared predicate (shared/prompt-acceptance.ts)
 * the input-locked case uses, not silently queued behind the run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  initialModelOverride: vi.fn(() => null),
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      autoGroupMovement: false,
      tabGroupMode: 'manual',
      planningGroupId: 'group-planning',
      inProgressGroupId: 'group-inprogress',
      doneGroupId: 'group-done',
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
      addRecentBaseDirectory: vi.fn(),
      defaultTallConversation: false,
      engineProfiles: [],
      engineDefaultModel: null,
      tabGroups: [
        { id: 'group-default', label: 'Default', isDefault: true, order: 0 },
      ],
    })),
  },
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockPrompt = vi.fn(async () => {})
;(globalThis as any).window = {
  ion: {
    prompt: mockPrompt,
    setPermissionMode: vi.fn(),
    steer: vi.fn(),
  },
  crypto: { randomUUID: () => 'uuid-1234' },
}

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null, lastActivityAt: null, idleSince: null, lastCompletionAt: null, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null, manualUnread: false,
    currentActivity: '',
    attachments: [],
    title: 'New Tab',
    customTitle: null,
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '/home/test',
    hasChosenDirectory: true,
    additionalDirs: [],
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    inputLocked: false,
    engineProfileId: null,
    lastMessagePreview: null,
    ...overrides,
  }
}

function buildHarness(initialTab: TabState) {
  const state: any = {
    tabs: [initialTab],
    activeTabId: initialTab.id,
    scrollToBottomCounter: 0,
    staticInfo: {
      homePath: '/home/test',
      projectPath: '/home/test',
      version: '1',
      email: null,
      subscriptionType: null,
    },
    backend: 'api' as const,
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    worktreeUncommittedMap: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    conversationPanes: seedMainPane(initialTab.id, {}),
    engineModelFallbacks: new Map(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
  }
  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })
  const get = () => state as State
  Object.assign(state, createTabSlice(set, get), createSendSlice(set, get))
  state.moveTabToGroup = vi.fn()
  state.handleError = vi.fn()
  return { state }
}

beforeEach(() => {
  mockPrompt.mockReset().mockResolvedValue(undefined)
})

describe('submit() on a conversation being compacted', () => {
  it('drops the prompt: nothing reaches the wire', () => {
    const { state } = buildHarness(makeTab({ isCompacting: true }))

    state.submit('tab-1', 'a follow-up the operator typed')

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it('tells the operator, in the conversation, that nothing was sent', () => {
    const { state } = buildHarness(makeTab({ isCompacting: true }))

    state.submit('tab-1', 'a follow-up the operator typed')

    const pane = state.conversationPanes.get('tab-1')
    const main = pane?.instances.find((i: { id: string }) => i.id === 'main')
    expect(main?.messages ?? []).toHaveLength(1)
    expect(main?.messages[0].role).toBe('system')
    expect(main?.messages[0].content).toContain('Not sent')
    expect(main?.messages[0].content).toContain('kept')
  })

  it('returns the refusal so a mirror caller can restore the text', () => {
    const { state } = buildHarness(makeTab({ isCompacting: true }))

    const result = state.submit('tab-1', 'a follow-up the operator typed')

    expect(result).toEqual({
      accepted: false,
      reason: 'compacting',
      message: expect.stringContaining('Not sent'),
    })
  })

  it('refuses even when status is running — the CLI backend dispatches /compact as an ordinary turn', () => {
    // The delegated-CLI backends have no CompactNow, so dispatchCompact's
    // idle sub-path runs /compact as a real turn: status is 'running' for
    // the whole compaction. isCompacting is the only signal a prompt during
    // it cannot be treated as an ordinary mid-turn steer.
    const { state } = buildHarness(makeTab({ status: 'running', isCompacting: true }))

    const result = state.submit('tab-1', 'a follow-up the operator typed')

    expect(mockPrompt).not.toHaveBeenCalled()
    expect(result).toMatchObject({ accepted: false, reason: 'compacting' })
  })

  it('an idle, non-compacting tab still submits (the guard reads the flag, not the flow)', () => {
    const { state } = buildHarness(makeTab({ isCompacting: false }))

    state.submit('tab-1', 'a normal prompt')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
  })

  it('submitRemotePrompt is guarded too: an iOS prompt cannot route around the compaction refusal', () => {
    const { state } = buildHarness(makeTab({ isCompacting: true }))

    state.submitRemotePrompt('tab-1', 'a prompt relayed from the phone')

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it('submitRemotePrompt posts a visible notice — a log line is not feedback the phone can see', () => {
    // submitRemotePrompt has no caller to return a refusal to (iOS fires and
    // forgets), so a silent drop here means the phone operator's message just
    // vanishes with nothing anywhere they're looking. The notice is a normal
    // system message, so it reaches iOS through the same sync as any other
    // conversation content — no separate wire field required.
    const { state } = buildHarness(makeTab({ isCompacting: true }))

    state.submitRemotePrompt('tab-1', 'a prompt relayed from the phone')

    const pane = state.conversationPanes.get('tab-1')
    const main = pane?.instances.find((i: { id: string }) => i.id === 'main')
    expect(main?.messages ?? []).toHaveLength(1)
    expect(main?.messages[0].role).toBe('system')
    expect(main?.messages[0].content).toContain('Not sent')
  })
})
