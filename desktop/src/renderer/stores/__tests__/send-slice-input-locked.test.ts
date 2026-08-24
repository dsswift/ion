/**
 * submit() refuses input-locked conversations — the enforcement half of the
 * conflict-assist lock.
 *
 * The InputBar hides itself on a locked tab, but the guard must live in
 * submit() so no other entry point (remote command from iOS, queued prompt,
 * future caller) can route around it. The lock is applied AFTER the
 * machine-sent conflict-fix prompt, so exactly one submission passes and
 * everything after is dropped without side effects.
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
    lastEventAt: null,    lastActivityAt: null,    idleSince: null,    lastCompletionAt: null,    settledOverride: null,    settledAt: null,    snoozedUntil: null,    snoozedAt: null,    lastVisitedAt: null,    manualUnread: false,
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

describe('submit() on an input-locked conversation', () => {
  it('drops the prompt: nothing reaches the wire', () => {
    const { state } = buildHarness(makeTab({ inputLocked: true }))

    state.submit('tab-1', 'a follow-up the operator typed')

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it('tells the operator, in the conversation, that nothing was sent', () => {
    // A refusal used to be a WARN line and nothing else: the text vanished
    // from a composer that looked merely busy, with no explanation anywhere
    // the operator was looking. The notice is the feedback.
    const { state } = buildHarness(makeTab({ inputLocked: true }))

    state.submit('tab-1', 'a follow-up the operator typed')

    const pane = state.conversationPanes.get('tab-1')
    const main = pane?.instances.find((i: { id: string }) => i.id === 'main')
    expect(main?.messages ?? []).toHaveLength(1)
    expect(main?.messages[0].role).toBe('system')
    expect(main?.messages[0].content).toContain('Not sent')
    // The operator must not be left wondering whether to retype.
    expect(main?.messages[0].content).toContain('kept')
  })

  it('returns the refusal so a mirror caller can restore the text', () => {
    // submit() is a FORWARDED action. When the Studio presentation is active
    // the InputBar's pre-check reads MIRROR state while this guard reads OWNER
    // state, so the refusal has to travel back for the text to be restored.
    const { state } = buildHarness(makeTab({ inputLocked: true }))

    const result = state.submit('tab-1', 'a follow-up the operator typed')

    expect(result).toEqual({
      accepted: false,
      reason: 'input-locked',
      message: expect.stringContaining('Not sent'),
    })
  })

  it('reports acceptance when the prompt is admitted', () => {
    const { state } = buildHarness(makeTab({ inputLocked: false }))

    const result = state.submit('tab-1', 'a normal prompt')

    expect(result).toEqual({ accepted: true })
  })

  it('an unlocked tab still submits (the guard reads the flag, not the flow)', () => {
    // Red if the guard were inverted or over-broad: the same harness with
    // inputLocked=false must pass the prompt through to window.ion.prompt.
    const { state } = buildHarness(makeTab({ inputLocked: false }))

    state.submit('tab-1', 'a normal prompt')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
  })

  it('adds no notice when the prompt is accepted', () => {
    const { state } = buildHarness(makeTab({ inputLocked: false }))

    state.submit('tab-1', 'a normal prompt')

    const pane = state.conversationPanes.get('tab-1')
    const main = pane?.instances.find((i: { id: string }) => i.id === 'main')
    const notices = (main?.messages ?? []).filter(
      (m: { role: string; content: string }) => m.role === 'system' && m.content.includes('Not sent'),
    )
    expect(notices).toHaveLength(0)
  })

  it('submitRemotePrompt is guarded too: an iOS prompt cannot route around the lock', () => {
    // The desktop is the authority on what reaches the engine — iOS hides its
    // input bar and guards its own submit, but the wire path must refuse
    // regardless of what the client sends.
    const { state } = buildHarness(makeTab({ inputLocked: true }))

    state.submitRemotePrompt('tab-1', 'a prompt relayed from the phone')

    expect(mockPrompt).not.toHaveBeenCalled()
  })
})
