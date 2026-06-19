/**
 * send-slice optimistic-bubble PILL tests.
 *
 * When the user submits a slash command (e.g. `/diagram ...`), the renderer's
 * sendMessage inserts an OPTIMISTIC user bubble immediately, before any engine
 * round-trip. At that moment there is no engine slash metadata yet
 * (`slashCommand`/`slashArgs` arrive later via load_session_history). The
 * bubble simply carries the RAW typed text as `content`.
 *
 * This pins the contract that makes the pill render anyway: the optimistic
 * bubble's `content` is the raw `/command args` text and carries NO
 * slashCommand metadata, so UserMessage's FALLBACK `parseSlashCommand` path
 * pills it. (The pill decision itself is unit-tested in
 * components/conversation/__tests__/UserMessage.test.ts.)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
      tabGroupMode: 'off',
      planningGroupId: null,
      inProgressGroupId: null,
      doneGroupId: null,
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
      addRecentBaseDirectory: vi.fn(),
      incrementDirectoryUsage: vi.fn(),
      defaultTallConversation: false,
      engineProfiles: [],
      engineDefaultModel: null,
      tabGroups: [],
    })),
  },
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import { resolveSlashPill } from '../../components/conversation/slash-pill'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

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
    lastEventAt: null,
    hasUnread: false,
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
    permissionMode: 'auto',
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    hasFileActivity: false,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    hasEngineExtension: false,
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
    staticInfo: { homePath: '/home/test', projectPath: '/home/test', version: '1', email: null, subscriptionType: null },
    backend: 'api' as const,
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    worktreeUncommittedMap: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    conversationPanes: seedMainPane(initialTab.id, { permissionMode: initialTab.permissionMode }),
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

describe('sendMessage — optimistic slash bubble pills via fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('inserts a bubble whose content is the RAW /command text with no engine metadata', () => {
    const { state } = buildHarness(makeTab())

    state.sendMessage('/diagram the auth flow')

    const inst = mainInstance(state.conversationPanes, 'tab-1')!
    const bubble = inst.messages[inst.messages.length - 1]
    expect(bubble.role).toBe('user')
    // Raw text preserved verbatim — the optimistic bubble does not expand it.
    expect(bubble.content).toBe('/diagram the auth flow')
    // No engine slash metadata at optimistic time (arrives later via history).
    expect(bubble.slashCommand).toBeUndefined()

    // Because content starts with `/`, the FALLBACK pill path resolves it
    // even without metadata — this is what makes the optimistic pill render.
    const pill = resolveSlashPill(bubble, bubble.content)
    expect(pill).toEqual({ command: '/diagram', args: 'the auth flow' })
  })

  it('does NOT pill an ordinary (non-slash) optimistic bubble', () => {
    const { state } = buildHarness(makeTab())

    state.sendMessage('hello world')

    const inst = mainInstance(state.conversationPanes, 'tab-1')!
    const bubble = inst.messages[inst.messages.length - 1]
    expect(bubble.content).toBe('hello world')
    expect(resolveSlashPill(bubble, bubble.content)).toBeNull()
  })
})
