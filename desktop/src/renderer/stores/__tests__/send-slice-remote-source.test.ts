/**
 * Regression test: `submit()` must forward `source: 'remote'` to the
 * IPC.PROMPT call when the prompt originated from iOS.
 *
 * Bug: for extension-hosted (engine) tabs, iOS prompt arrived via
 * REMOTE_ENGINE_PROMPT -> renderer submit() -> window.ion.prompt().
 * `submit()` did not pass `source: 'remote'` in RunOptions, so the
 * IPC.PROMPT handler treated it as a desktop-typed prompt and echoed
 * a second `desktop_message_added` to iOS with a renderer-generated id.
 * iOS then had two user bubbles: the optimistic insert (clientMsgId) and
 * the redundant echo (renderer requestId). Plain tabs worked because
 * `submitRemotePrompt` already passed `source: 'remote'`.
 *
 * Fix: `submit()` accepts and forwards `opts.source` to the prompt call.
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
      tabGroupMode: 'manual',
      planningGroupId: 'group-planning',
      inProgressGroupId: 'group-inprogress',
      doneGroupId: 'group-done',
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
      addRecentBaseDirectory: vi.fn(),
      incrementDirectoryUsage: vi.fn(),
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
import type { ConversationInstance } from '../../../shared/types-engine'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockPrompt = vi.fn(async () => {})
const mockSetPermissionMode = vi.fn()
const mockSteer = vi.fn()
;(globalThis as any).window = {
  ion: {
    prompt: mockPrompt,
    setPermissionMode: mockSetPermissionMode,
    steer: mockSteer,
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
    engineProfileId: null,
    lastMessagePreview: null,
    ...overrides,
  }
}

function buildHarness(
  initialTab: TabState,
  instanceOverrides: Partial<ConversationInstance> = {},
) {
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
    engineUsage: new Map(),
    conversationPanes: seedMainPane(initialTab.id, {
      ...instanceOverrides,
    }),
    engineModelFallbacks: new Map(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
  }

  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })

  const get = () => state as State

  const handleError = vi.fn()
  const moveTabToGroup = vi.fn()

  const tabSlice = createTabSlice(set, get)
  const sendSlice = createSendSlice(set, get)

  Object.assign(state, tabSlice, sendSlice)
  state.moveTabToGroup = moveTabToGroup
  state.handleError = handleError

  return { state, set }
}

beforeEach(() => {
  mockPrompt.mockReset().mockResolvedValue(undefined)
  mockSetPermissionMode.mockReset()
  mockSteer.mockReset()
})

describe('submit() forwards source to window.ion.prompt', () => {
  it('passes source=remote when opts.source is remote (engine tab from iOS)', () => {
    const tab = makeTab({ hasChosenDirectory: true, engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    state.submit('tab-1', 'hello from ios', { source: 'remote' })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.objectContaining({ source: 'remote' }),
    )
  })

  it('does NOT pass source when opts.source is omitted (desktop-typed)', () => {
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submit('tab-1', 'hello from desktop')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.not.objectContaining({ source: 'remote' }),
    )
  })

  it('submitRemotePrompt passes source=remote (plain tab from iOS, baseline)', () => {
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submitRemotePrompt('tab-1', 'hello from ios plain')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.objectContaining({ source: 'remote' }),
    )
  })
})

describe('submitRemotePrompt optimistic attachments (iOS-sent images)', () => {
  // Regression: the desktop bubble never showed an iOS-sent image live. The
  // pipeline rewrites the prompt to the pathless "(content attached)" form
  // before REMOTE_USER_MESSAGE, so the marker regex in deriveMessageImages
  // finds nothing — the structured attachments field is the only render
  // source. It must be populated from the forwarded raw attachments.
  it('populates userMessage.attachments from remoteAttachments with id === path', () => {
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submitRemotePrompt(
      'tab-1',
      '[Attachment: photo.jpeg (content attached)]\n\nwhat is this?',
      undefined,
      undefined,
      [{ type: 'image', name: 'photo.jpeg', path: '/tmp/ion-remote-1.jpeg' }],
    )

    const pane = state.conversationPanes.get('tab-1')
    const inst = pane.instances[0]
    const userMsg = inst.messages[inst.messages.length - 1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.attachments).toEqual([
      { id: '/tmp/ion-remote-1.jpeg', type: 'image', name: 'photo.jpeg', path: '/tmp/ion-remote-1.jpeg' },
    ])
  })

  it('leaves attachments undefined when no remoteAttachments are forwarded', () => {
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submitRemotePrompt('tab-1', 'plain prompt')

    const pane = state.conversationPanes.get('tab-1')
    const inst = pane.instances[0]
    const userMsg = inst.messages[inst.messages.length - 1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.attachments).toBeUndefined()
  })
})
