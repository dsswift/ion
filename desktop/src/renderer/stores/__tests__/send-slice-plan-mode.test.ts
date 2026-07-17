/**
 * send-slice plan-mode convergence tests.
 *
 * Verifies that sendMessage and submitRemotePrompt handle plan-mode state
 * identically:
 *   - Both call setPermissionMode before the prompt (prompt_sync)
 *   - Both clear permissionDenied when a new prompt is submitted
 *   - Both pass planFilePath from tab state to window.ion.prompt
 *
 * Uses the same harness pattern as tab-group-pin.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'mock-tab',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle' as const,
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    customTitle: null,
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
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
  })),
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
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

// ── global window stub ────────────────────────────────────────────────────────

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

// ── test state builder ────────────────────────────────────────────────────────

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

  const moveTabToGroup = vi.fn()
  const handleError = vi.fn()

  // Build slices
  const tabSlice = createTabSlice(set, get)
  const sendSlice = createSendSlice(set, get)

  Object.assign(state, tabSlice, sendSlice)
  state.moveTabToGroup = moveTabToGroup
  state.handleError = handleError

  return { state, set }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('prompt_sync parity — setPermissionMode before prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('sendMessage calls setPermissionMode with current plan mode', () => {
    // permissionMode lives on the instance (WI-002) — pass as instanceOverride
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan' })

    state.submit('tab-1', 'hello')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', undefined)
  })

  it('submitRemotePrompt calls setPermissionMode with current plan mode', () => {
    // permissionMode lives on the instance (WI-002) — pass as instanceOverride
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan' })

    state.submitRemotePrompt('tab-1', 'hello')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', undefined)
  })

  it('forwards the instance planFilePath on the plan-mode prompt_sync (continuity)', () => {
    // Plan-file continuity: when the tab is in plan mode and the instance has
    // a persisted planFilePath, the prompt_sync setPermissionMode call carries
    // it as the 4th arg so the engine restores the existing plan even before
    // the prompt is dispatched. Pre-fix this arg was absent (undefined).
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan', planFilePath: '/plans/simple-sailing-pine.md' })

    state.submit('tab-1', 'hello')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', '/plans/simple-sailing-pine.md')
  })

  it('does NOT forward planFilePath on an auto prompt_sync (engine ignores it)', () => {
    const { state } = buildHarness(makeTab(), { permissionMode: 'auto', planFilePath: '/plans/simple-sailing-pine.md' })

    state.submit('tab-1', 'hello')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'auto', 'prompt_sync', undefined)
  })

  // ── slash-aware prompt_sync (the /align-in-plan-mode regression) ──────────────
  // A slash command is a "run this task" intent that the main-process pipeline
  // flips plan→auto for. The renderer's prompt_sync re-assert must NOT re-arm
  // `plan` for a slash prompt, or it fights (and beats) the flip. So a slash
  // command on a plan-mode tab must sync `auto`, not `plan`.

  it('sendMessage syncs AUTO (not plan) when the prompt is a slash command', () => {
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan', planFilePath: '/plans/p.md' })

    state.submit('tab-1', '/align')

    // Must be auto — and must NOT have been called with 'plan' for this prompt.
    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'auto', 'prompt_sync', undefined)
    expect(mockSetPermissionMode).not.toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', expect.anything())
  })

  it('submitRemotePrompt syncs AUTO (not plan) when the prompt is a slash command', () => {
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan', planFilePath: '/plans/p.md' })

    state.submitRemotePrompt('tab-1', '/align')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'auto', 'prompt_sync', undefined)
    expect(mockSetPermissionMode).not.toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', expect.anything())
  })

  it('sendMessage still syncs PLAN for /clear (a checkpoint, not a task)', () => {
    // /clear is excluded from the slash-aware skip: the pipeline never flips it,
    // so re-asserting the real mode keeps clear from silently leaving plan mode.
    const { state } = buildHarness(makeTab(), { permissionMode: 'plan', planFilePath: '/plans/p.md' })

    state.submit('tab-1', '/clear')

    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', '/plans/p.md')
  })
})

describe('permissionDenied clearing on new prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('sendMessage clears permissionDenied', () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, {
      permissionDenied: { tools: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }] } as any,
    })

    state.submit('tab-1', 'amend')

    expect(mainInstance(state.conversationPanes, 'tab-1')?.permissionDenied).toBeNull()
  })

  it('submitRemotePrompt clears permissionDenied', () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, {
      permissionDenied: { tools: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }] } as any,
    })

    state.submitRemotePrompt('tab-1', 'amend')

    expect(mainInstance(state.conversationPanes, 'tab-1')?.permissionDenied).toBeNull()
  })
})

describe('planFilePath forwarding from tab state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('sendMessage passes planFilePath to window.ion.prompt options', () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, { planFilePath: '/plans/test.md' })

    state.submit('tab-1', 'impl')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const args = mockPrompt.mock.calls[0] as unknown as any[]
    expect(args[2].planFilePath).toBe('/plans/test.md')
  })

  it('submitRemotePrompt passes planFilePath to window.ion.prompt options', () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, { planFilePath: '/plans/test.md' })

    state.submitRemotePrompt('tab-1', 'impl')

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const args = mockPrompt.mock.calls[0] as unknown as any[]
    expect(args[2].planFilePath).toBe('/plans/test.md')
  })
})

describe('Fix A — auto-exit does not corrupt prompt_sync assertion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('instance stays plan after auto-exit so follow-up prompt_sync asserts plan not auto', () => {
    // Instance permissionMode:'plan' + planFilePath set (Fix A: auto-exit does
    // NOT flip this to 'auto', so the instance stays 'plan' when the user sends
    // a follow-up prompt without approving).
    const { state } = buildHarness(makeTab(), {
      permissionMode: 'plan',
      planFilePath: '/plans/active-plan.md',
    })

    // Simulate: event reducer received plan_mode_auto_exit but did NOT
    // flip permissionMode (Fix A). Instance is still 'plan'.
    expect(mainInstance(state.conversationPanes, 'tab-1')!.permissionMode).toBe('plan')

    // User sends a follow-up comment without approving
    state.submit('tab-1', 'can you also check edge cases')

    // prompt_sync must re-assert 'plan', never 'auto'
    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'prompt_sync', '/plans/active-plan.md')
    expect(mockSetPermissionMode).not.toHaveBeenCalledWith('tab-1', 'auto', expect.anything(), expect.anything())
  })
})
