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
  initialModelOverride: vi.fn((..._a: any[]) => null),
  nextMsgId: vi.fn((..._a: any[]) => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async (..._a: any[]) => {}),
  cancelDoneGroupMove: vi.fn((..._a: any[]) => false),
  scheduleDoneGroupMove: vi.fn(),
}))

// Titling reads the conversation's Personal-preferences stamp. These tests are
// not about titling, so the stamp turns it off.
vi.mock('../conversation-preferences-read', () => ({
  conversationPreferencesFor: () => ({ defaultPermissionMode: 'plan', defaultThinkingEffort: 'medium', aiGeneratedTitles: false, enableClaudeCompat: false, enableEarlyStopContinuation: false }),
}))

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn((..._a: any[]) => ({
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
      addRecentBaseDirectory: vi.fn(),
      engineProfiles: [],
      engineDefaultModel: null,
    })),
  },
}))

const mockPrompt = vi.fn(async (..._a: any[]) => {})
const mockSetPermissionMode = vi.fn()
const mockSteer = vi.fn()
const mockEchoUserTurnToStudio = vi.fn()
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: (...args: any[]) => mockEchoUserTurnToStudio(...args),
  prompt: (...args: any[]) => mockPrompt(...args),
  setPermissionMode: (...args: any[]) => mockSetPermissionMode(...args),
  steer: (...args: any[]) => mockSteer(...args),
  cancelBash: vi.fn(),
  engineAbort: vi.fn(),
  closeTab: vi.fn(),
  createTab: vi.fn(),
  deleteTabContent: vi.fn(),
  saveSessionLabel: vi.fn(),
  start: vi.fn(),
  tabMetaChanged: vi.fn(),
  terminalDestroy: vi.fn(),
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '@ion/shared/types'
import type { ConversationInstance } from '@ion/shared/types-engine'
import { seedMainPane } from './helpers/conversation-test-helpers'

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
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
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

  it('submitRemotePrompt sends full-context messages to the engine', () => {
    const tab = makeTab({ hasChosenDirectory: true, contextTokens: 911_135, contextWindow: 1_000_000 })
    const { state } = buildHarness(tab)

    state.submitRemotePrompt('tab-1', 'resume from ios')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.objectContaining({ prompt: 'resume from ios', source: 'remote' }),
    )
  })

  it('preserves remote implementation provenance and sends it to the engine', () => {
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submitRemotePrompt('tab-1', 'Implement the plan.', undefined, undefined, undefined, 'impl-remote', true)

    const message = state.conversationPanes.get('tab-1')!.instances[0].messages.at(-1)
    expect(message).toMatchObject({ role: 'user', implementationPhase: true })
    expect(mockPrompt).toHaveBeenCalledWith('tab-1', 'impl-remote', expect.objectContaining({
      implementationPhase: true,
    }))
  })

  it('echoes a desktop-typed prompt to the Studio mirror with the bubble it inserted', () => {
    // The mirror forwarded `submit` here and inserted nothing; without this
    // echo the operator's own message never appeared while the reply did.
    mockEchoUserTurnToStudio.mockClear()
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submit('tab-1', 'hello from the keyboard')

    const bubble = state.conversationPanes.get('tab-1')!.instances[0].messages.at(-1)!
    expect(bubble).toMatchObject({ role: 'user', content: 'hello from the keyboard' })
    expect(mockEchoUserTurnToStudio).toHaveBeenCalledTimes(1)
    expect(mockEchoUserTurnToStudio).toHaveBeenCalledWith({
      tabId: 'tab-1',
      id: bubble.id,
      content: 'hello from the keyboard',
      timestamp: bubble.timestamp,
    })
  })

  it('echoes the attached image to the Studio mirror with the bubble it inserted', () => {
    // The bubble's inline preview renders from `attachments`; the text only
    // carries a stripped marker. An echo without them drew the words and no
    // image in the Studio window.
    mockEchoUserTurnToStudio.mockClear()
    const image = { id: 'att-1', type: 'image' as const, name: 'shot.png', path: '/u/.ion/user-images/abc.png', dataUrl: 'data:image/png;base64,AAAA' }
    const tab = makeTab({ hasChosenDirectory: true, attachments: [image] })
    const { state } = buildHarness(tab)

    state.submit('tab-1', 'Analyze the attached files.')

    const bubble = state.conversationPanes.get('tab-1')!.instances[0].messages.at(-1)!
    expect(bubble.attachments).toEqual([image])
    expect(mockEchoUserTurnToStudio).toHaveBeenCalledWith(expect.objectContaining({
      id: bubble.id,
      attachments: [image],
    }))
  })

  it('does not echo a remote-source prompt to the mirror (tabs-prompt.ts owns that echo)', () => {
    mockEchoUserTurnToStudio.mockClear()
    const tab = makeTab({ hasChosenDirectory: true })
    const { state } = buildHarness(tab)

    state.submit('tab-1', 'hello from ios', { source: 'remote' })

    expect(mockEchoUserTurnToStudio).not.toHaveBeenCalled()
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
