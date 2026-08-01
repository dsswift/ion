/**
 * Regression: iOS-originated slash commands through REMOTE_ENGINE_PROMPT must
 * leave the user turn in the desktop renderer store AND forward the
 * resolveSlash flag so the pipeline short-circuits to submitAsPrompt instead
 * of re-dispatching the extension command.
 *
 * Root cause: REMOTE_ENGINE_PROMPT did not carry resolveSlash, so the
 * renderer's submit() round-tripped through window.ion.prompt() without the
 * flag. The pipeline re-parsed the slash, dispatched a SECOND extension
 * command, and the command-await FIFO queue consumed the result meant for the
 * second dispatch with a fire-and-forget surfaceEngineUnknownCommand waiter
 * from the first dispatch. The second dispatchExtensionCommand timed out (5s),
 * the failure branch inserted "Command failed: /align: timeout" and called
 * clearConnectingStatus, and the resolveSlash re-submit never ran. The user
 * bubble showed briefly (optimistic insert) then disappeared when the tab
 * reset to idle with no engine run.
 *
 * Fix: forward resolveSlash through REMOTE_ENGINE_PROMPT -> submit() opts ->
 * window.ion.prompt() RunOptions. The pipeline's resolveSlash short-circuit
 * (processIncomingPrompt line ~453) fires, skipping the extension command
 * dispatch entirely.
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
      thinkingEnabled: false,
    })),
  },
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import { createEngineSubmitActions } from '../slices/engine-slice-submit'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

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
  const engineSubmitSlice = createEngineSubmitActions(set, get)

  Object.assign(state, tabSlice, sendSlice, engineSubmitSlice)
  state.moveTabToGroup = moveTabToGroup
  state.handleError = handleError

  return { state, set }
}

beforeEach(() => {
  mockPrompt.mockReset().mockResolvedValue(undefined)
  mockSetPermissionMode.mockReset()
  mockSteer.mockReset()
})

describe('iOS-originated slash prompt via REMOTE_ENGINE_PROMPT', () => {
  it('user turn is present in the renderer store after submit (slash prompt, source=remote)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Simulate the REMOTE_ENGINE_PROMPT handler: submit with source='remote'
    // and resolveSlash=true (the pipeline already resolved the slash and set
    // this flag before broadcasting REMOTE_ENGINE_PROMPT).
    state.submit('tab-1', '/align', { source: 'remote', resolveSlash: true })

    // The optimistic user message must be in the store.
    const inst = mainInstance(state.conversationPanes, 'tab-1')
    expect(inst).toBeDefined()
    const userMsgs = inst!.messages.filter((m: any) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('/align')
  })

  it('forwards resolveSlash=true to window.ion.prompt (prevents re-dispatch loop)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    state.submit('tab-1', '/align', { source: 'remote', resolveSlash: true })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.objectContaining({ resolveSlash: true, source: 'remote' }),
    )
  })

  it('does NOT forward resolveSlash for a desktop-typed slash (no false positive)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Desktop-typed: no source, no resolveSlash
    state.submit('tab-1', '/align')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    // resolveSlash should be undefined (not present)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.not.objectContaining({ resolveSlash: true }),
    )
  })

  it('does NOT forward resolveSlash for a plain iOS message (regression guard)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Remote source, plain text (not a slash) - no resolveSlash
    state.submit('tab-1', 'hello from ios', { source: 'remote' })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    // resolveSlash should not be true
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.not.objectContaining({ resolveSlash: true }),
    )
    // source still forwarded (double-echo fix preserved)
    expect(mockPrompt).toHaveBeenCalledWith(
      'tab-1',
      expect.any(String),
      expect.objectContaining({ source: 'remote' }),
    )
  })

  it('user turn survives alongside source=remote (no store-skip regression)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Plain remote message: user turn must be in the store
    state.submit('tab-1', 'hello from ios', { source: 'remote' })

    const inst = mainInstance(state.conversationPanes, 'tab-1')
    const userMsgs = inst!.messages.filter((m: any) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('hello from ios')
  })
})

describe('iOS slash: extension command SUCCESS path (commandError === "")', () => {
  /**
   * Regression: when an iOS slash command is handled by an extension directly
   * (commandError === ''), the extension's ctx.sendPrompt starts a run on the
   * engine, but the desktop pipeline's success path returned without ever
   * calling submit() on the renderer. The renderer store had the assistant
   * response (from text_chunk events) but NO user message for the /align
   * prompt. iOS history reads pull from the renderer store, so both clients
   * showed assistant text with no preceding user bubble.
   *
   * Fix: insertRemoteUserMessage is called in the extension-command-success
   * path for remote prompts, injecting the user bubble directly into the
   * renderer store without triggering a new engine prompt.
   */

  it('insertRemoteUserMessage adds user turn to store (extension cmd success path)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Simulate what the pipeline does on the extension-command-success path:
    // call insertRemoteUserMessage directly (this is what the main-process
    // helper routes through via executeJavaScript)
    state.insertRemoteUserMessage('tab-1', '/align', '/align', '')

    const inst = mainInstance(state.conversationPanes, 'tab-1')
    expect(inst).toBeDefined()
    const userMsgs = inst!.messages.filter((m: any) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('/align')
    expect(userMsgs[0].slashCommand).toBe('/align')
    expect((userMsgs[0] as any).source).toBe('remote')
  })

  it('user turn from insertRemoteUserMessage survives when engine run adds assistant text', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // Step 1: pipeline inserts user turn for the iOS slash prompt
    state.insertRemoteUserMessage('tab-1', '/align', '/align', '')

    // Step 2: simulate engine run starting and producing assistant text
    // (the engine emits text_chunk, which the event-slice appends)
    const inst1 = mainInstance(state.conversationPanes, 'tab-1')
    expect(inst1).toBeDefined()

    // Verify user message is present before assistant arrives
    const userBefore = inst1!.messages.filter((m: any) => m.role === 'user')
    expect(userBefore).toHaveLength(1)
    expect(userBefore[0].content).toBe('/align')

    // Step 3: a second insertRemoteUserMessage should NOT replace the first
    // (this verifies no id collision)
    state.insertRemoteUserMessage('tab-1', '/review', '/review', '')
    const inst2 = mainInstance(state.conversationPanes, 'tab-1')
    const allUser = inst2!.messages.filter((m: any) => m.role === 'user')
    expect(allUser).toHaveLength(2)
    expect(allUser[0].content).toBe('/align')
    expect(allUser[1].content).toBe('/review')
  })

  it('insertRemoteUserMessage works without slash metadata (plain remote text)', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    state.insertRemoteUserMessage('tab-1', 'hello from ios')

    const inst = mainInstance(state.conversationPanes, 'tab-1')
    const userMsgs = inst!.messages.filter((m: any) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('hello from ios')
    expect(userMsgs[0].slashCommand).toBeUndefined()
    expect((userMsgs[0] as any).source).toBe('remote')
  })

  it('full iOS slash sequence: user turn present after extension run starts', () => {
    const tab = makeTab({ engineProfileId: 'profile-1' })
    const { state } = buildHarness(tab)

    // The full sequence for an iOS /align that an extension handles:
    // 1. Pipeline inserts the user turn (replaces the missing submit() call)
    state.insertRemoteUserMessage('tab-1', '/align', '/align', '')

    // 2. Extension's ctx.sendPrompt starts a run; engine emits session_init,
    //    then text_chunk events. Simulate by directly appending an assistant
    //    message (mirroring what handleNormalizedEvent does for text_chunk).
    const inst = mainInstance(state.conversationPanes, 'tab-1')!
    const assistantMsg = { id: 'msg-asst-1', role: 'assistant' as const, content: "I'll start by detecting the mode.", timestamp: Date.now() }
    // Direct mutation to simulate event-slice behavior
    state.conversationPanes = new Map(state.conversationPanes)
    const pane = state.conversationPanes.get('tab-1')!
    const updatedInst = { ...inst, messages: [...inst.messages, assistantMsg] }
    state.conversationPanes.set('tab-1', {
      ...pane,
      instances: pane.instances.map((i: any) => i.id === inst.id ? updatedInst : i),
    })

    // 3. Verify: the /align user turn MUST still be present alongside the
    //    assistant text. Both messages must be in order.
    const finalInst = mainInstance(state.conversationPanes, 'tab-1')!
    expect(finalInst.messages).toHaveLength(2)
    expect(finalInst.messages[0].role).toBe('user')
    expect(finalInst.messages[0].content).toBe('/align')
    expect((finalInst.messages[0] as any).slashCommand).toBe('/align')
    expect(finalInst.messages[1].role).toBe('assistant')
    expect(finalInst.messages[1].content).toBe("I'll start by detecting the mode.")
  })
})
