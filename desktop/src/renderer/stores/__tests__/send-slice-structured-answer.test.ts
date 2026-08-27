/**
 * Guided Questions transcript behavior.
 *
 * A submitted answer set is real operator input, so it stays visible and is
 * tagged `structured_answer`. Its displayText contains only questions and
 * answers. The separate provider prompt can still carry control instructions.
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
    tabRole: null,
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

/** The RunOptions object handed to `window.ion.prompt(tabId, requestId, opts)`. */
function promptOptions(call = 0): Record<string, unknown> {
  // mockPrompt is declared with a zero-arg signature (matching the sibling
  // send-slice suites), so the recorded call tuple has no static element at
  // index 2. Widen through unknown to read the third positional argument.
  const calls = mockPrompt.mock.calls as unknown as unknown[][]
  return calls[call][2] as Record<string, unknown>
}

beforeEach(() => {
  mockPrompt.mockReset().mockResolvedValue(undefined)
})

/** The instance's messages after a send. */
function messages(state: any, tabId = 'tab-1'): unknown[] {
  const pane = state.conversationPanes.get(tabId)
  return pane?.instances.find((i: { id: string }) => i.id === 'main')?.messages ?? []
}

describe("submit() with injectionKind: 'structured_answer'", () => {
  it('RENDERS the submission and stamps it so the bubble can label itself', () => {
    // Reversed deliberately. An earlier revision HID this turn, reasoning it
    // was a machine rendering of the wizard. That dropped real operator work
    // from the transcript: they read the questions, chose the options, typed
    // the text and attached the images. It renders — with a "Questions
    // answered" tag so it never reads as free prose they typed.
    const { state } = buildHarness(makeTab())

    state.submit('tab-1', 'My answers to "Scope": ...', {
      source: 'remote',
      requestId: 'questions-1',
      injectionKind: 'structured_answer',
    })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const msgs = messages(state) as Array<{ injectionKind?: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].injectionKind).toBe('structured_answer')
  })

  it('forwards the kind to the engine so the PERSISTED row is classified', () => {
    // RED without `injectionKind` in the RunOptions: suppression would be
    // desktop-session-local and the turn would return on history reload.
    const { state } = buildHarness(makeTab())

    state.submit('tab-1', 'My answers to "Scope": ...', {
      source: 'remote',
      requestId: 'questions-1',
      injectionKind: 'structured_answer',
    })

    expect(promptOptions().injectionKind).toBe('structured_answer')
  })
  it('renders only displayText but sends the full provider prompt', () => {
    const { state } = buildHarness(makeTab())
    const providerPrompt = 'My answers to "Scope": ...\n\nCall AskUserQuestions again.'
    const displayText = '**Storage backend?**\n- Postgres'

    state.submit('tab-1', providerPrompt, {
      source: 'remote',
      requestId: 'questions-1',
      injectionKind: 'structured_answer',
      displayText,
    })

    const msgs = messages(state) as Array<{ content: string }>
    expect(msgs[0].content).toBe(displayText)
    expect(msgs[0].content).not.toContain('Call AskUserQuestions again')
    expect(promptOptions().prompt).toBe(providerPrompt)
    expect(promptOptions().displayText).toBe(displayText)
    expect(promptOptions().echoToIos).toBeUndefined()
    expect(state.enginePinnedPrompt.get('tab-1')).toBe(displayText)
  })


  it('still dispatches the prompt (the model MUST receive the answers)', () => {
    // The suppression is presentational only. If this ever stops dispatching,
    // the operator's answers are silently discarded — strictly worse than a
    // duplicate bubble.
    const { state } = buildHarness(makeTab())

    state.submit('tab-1', 'My answers to "Scope": chose Postgres', {
      source: 'remote',
      requestId: 'questions-1',
      injectionKind: 'structured_answer',
    })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(String(promptOptions().prompt)).toContain('chose Postgres')
  })
})

describe('submit() baseline — an ordinary typed turn is unchanged', () => {
  it('inserts the user bubble and sends no injectionKind', () => {
    // The guard against over-broad suppression: absent the kind, nothing about
    // the existing path changes.
    const { state } = buildHarness(makeTab())

    state.submit('tab-1', 'a turn I actually typed')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(messages(state)).toHaveLength(1)
    expect(promptOptions().injectionKind).toBeUndefined()
    expect(state.enginePinnedPrompt.get('tab-1')).toBe('a turn I actually typed')
  })

  it('an unknown kind is treated as user-authored (bubble kept)', () => {
    // A client cannot hide a turn by inventing a kind — the shared policy
    // only suppresses what the engine classifies, and the engine drops
    // unknown kinds server-side too.
    const { state } = buildHarness(makeTab())

    state.submit('tab-1', 'not really machine authored', {
      injectionKind: 'totally_made_up',
    })

    expect(messages(state)).toHaveLength(1)
  })
})
