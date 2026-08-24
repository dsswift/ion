/**
 * The `source: 'machine'` passage through the input lock — the admission half
 * of the conflict auto-fix lifecycle.
 *
 * ── Why this contract exists ────────────────────────────────────────────────
 * `openConflictAssist` tags the fresh tab with `tabRole: 'conflict-auto-fix'`
 * AND `inputLocked: true` ATOMICALLY, *before* it submits its single machine
 * prompt. The ordering is deliberate: the auto-fix lifecycle keys its
 * close-vs-retain decision on the role, and a fast completion could otherwise
 * land before the tagging and be missed entirely.
 *
 * That ordering has a consequence — the machine prompt must pass through the
 * lock the same flow just installed. `source: 'machine'` is that one passage.
 *
 * ── Why it needs pinning ────────────────────────────────────────────────────
 * Two invariants hold this together, and neither is visible from reading either
 * side alone:
 *
 *   1. `inputLocked && source !== 'machine'` — drop the `!== 'machine'` and the
 *      auto-fix flow's own prompt is refused, so the conversation never runs,
 *      never completes, and never self-closes. The tab just sits there locked
 *      and empty. Nothing in the type system or any other gate catches that.
 *   2. `source: source === 'remote' ? 'remote' : undefined` — 'machine' is a
 *      RENDERER-LOCAL marker, not a remote origin. Forwarding it verbatim
 *      (`source: source`) would make the IPC.PROMPT handler treat a
 *      desktop-internal prompt as an iOS-originated one and skip the
 *      `desktop_message_added` echo, so the phone would silently lose the
 *      user bubble for the machine prompt.
 *
 * Both are one-token edits away from breaking, which is exactly what a pinning
 * test is for.
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

describe("submit() with source: 'machine' on a locked auto-fix conversation", () => {
  it('passes the lock the auto-fix flow just installed (the one admitted prompt)', () => {
    // RED without `source !== 'machine'` in the send-slice guard: the auto-fix
    // conversation's own instruction would be refused, so the tab would never
    // run, never complete, and never self-close.
    const { state } = buildHarness(makeTab({
      inputLocked: true,
      tabRole: 'conflict-auto-fix',
    }))

    state.submit('tab-1', 'resolve the conflicted paths, then stage them', { source: 'machine' })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
  })

  it('still refuses an operator prompt on the same locked tab', () => {
    // The baseline the passage must not widen: only 'machine' passes. A typed
    // follow-up on the same tab is dropped, with no optimistic insert — the
    // prompt must never look like it was sent.
    const { state } = buildHarness(makeTab({
      inputLocked: true,
      tabRole: 'conflict-auto-fix',
    }))

    const result = state.submit('tab-1', 'actually, do it differently')

    expect(mockPrompt).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ accepted: false, reason: 'input-locked' }))
    const pane = state.conversationPanes.get('tab-1')
    const main = pane?.instances.find((i: { id: string }) => i.id === 'main')
    // No USER message: nothing was submitted. The one message present is the
    // refusal notice that tells the operator their text was kept — a silent
    // drop is what this guard used to do, and that cost a real instruction.
    expect((main?.messages ?? []).filter((m: { role: string }) => m.role === 'user')).toHaveLength(0)
    expect(main?.messages ?? []).toEqual([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('Not sent') }),
    ])
  })

  it('does not forward the marker as a remote origin', () => {
    // RED if the forwarding collapses to `source: source`: 'machine' would
    // reach the IPC.PROMPT handler, which reads a non-undefined source as
    // "already echoed to iOS" and skips desktop_message_added — the phone
    // would silently lose the user bubble. 'machine' is renderer-local only.
    const { state } = buildHarness(makeTab({
      inputLocked: true,
      tabRole: 'conflict-auto-fix',
    }))

    state.submit('tab-1', 'the machine prompt', { source: 'machine' })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(promptOptions().source).toBeUndefined()
  })

  it('leaves the remote passage untouched: source=remote still forwards', () => {
    // Guards against a fix that over-corrects the normalization and drops the
    // genuine remote marker along with the machine one.
    const { state } = buildHarness(makeTab({ inputLocked: false }))

    state.submit('tab-1', 'hello from ios', { source: 'remote' })

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(promptOptions().source).toBe('remote')
  })
})
