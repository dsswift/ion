/**
 * send-slice — send-time tab titling
 *
 * Pins the contract that LLM title generation fires at SEND TIME (in parallel
 * with the run), not at task_complete. The title is derived from the user's
 * first message — which is available instantly at submit() — so there is no
 * reason to wait for turn completion.
 *
 * Cases covered:
 *   1. Slash command → generateTitle NOT called; literal tab title preserved.
 *   2. Plain prose → generateTitle called with the exact prompt text.
 *   3. needsTitle=false (tab already has a non-default title) → NOT called.
 *   4. aiGeneratedTitles=false preference → NOT called.
 *   5. isBusy=true (mid-turn steer) → NOT called (needsTitle also false, but
 *      the !isBusy guard is belt-and-suspenders).
 *   6. Leading-whitespace slash is still recognized and skipped.
 *   7. submitRemotePrompt prose → generateTitle called.
 *   8. submitRemotePrompt slash → NOT called.
 *
 * Regression direction for case 1: removing the slash guard in
 * event-slice-titling.ts causes generateTitle to be called and case 1 goes red.
 * Regression direction for case 2: removing the maybeSendTimeTitle call from
 * send-slice.ts causes generateTitle never to be called and case 2 goes red.
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
      aiGeneratedTitles: true,
      autoGroupMovement: false,
      tabGroupMode: 'off' as const,
      planningGroupId: null,
      inProgressGroupId: null,
      doneGroupId: null,
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
      engineProfiles: [],
      engineDefaultModel: null,
      thinkingEnabled: false,
      tabGroups: [],
    })),
  },
}))

import { usePreferencesStore } from '../../preferences'
import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockGenerateTitle = vi.fn(async () => '')
const mockSaveSessionLabel = vi.fn(async () => {})
const mockTabMetaChanged = vi.fn()

;(globalThis as any).window = {
  ion: {
    prompt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(),
    steer: vi.fn(),
    generateTitle: mockGenerateTitle,
    saveSessionLabel: mockSaveSessionLabel,
    tabMetaChanged: mockTabMetaChanged,
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
    conversationPanes: seedMainPane(initialTab.id, { permissionMode: 'auto' }),
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
  state.renameTab = vi.fn((tabId: string, title: string) => {
    state.tabs = state.tabs.map((t: TabState) =>
      t.id === tabId ? { ...t, customTitle: title } : t,
    )
  })
  return { state }
}

/** Default prefs object with aiGeneratedTitles ON. */
function defaultPrefs(overrides: Record<string, unknown> = {}) {
  return {
    aiGeneratedTitles: true,
    autoGroupMovement: false,
    tabGroupMode: 'off' as const,
    planningGroupId: null,
    inProgressGroupId: null,
    doneGroupId: null,
    preferredModel: null,
    defaultPermissionMode: 'auto' as const,
    planModelSplitEnabled: false,
    planModeModel: null,
    engineProfiles: [],
    engineDefaultModel: null,
    thinkingEnabled: false,
    tabGroups: [],
    ...overrides,
  }
}

describe('send-slice — send-time tab titling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePreferencesStore.getState).mockReturnValue(defaultPrefs() as any)
    mockGenerateTitle.mockResolvedValue('')
  })

  it('skips LLM titling and preserves the literal title when first prompt is a slash command', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', '/clear arg')

    // The slash guard in maybeSendTimeTitle must suppress the LLM call.
    expect(mockGenerateTitle).not.toHaveBeenCalled()
    // send-slice still sets the truncated literal title at send time.
    expect(state.tabs[0].title).toBe('/clear arg')
  })

  it('fires LLM title generation when first prompt is plain prose', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', 'please refactor the parser')

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1)
    expect(mockGenerateTitle).toHaveBeenCalledWith('please refactor the parser')
  })

  it('does not call generateTitle when needsTitle is false (tab already has a title)', () => {
    const { state } = buildHarness(makeTab({ title: 'Some existing title' }))

    state.submit('tab-1', 'new message on existing tab')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
  })

  it('does not call generateTitle when aiGeneratedTitles preference is off', () => {
    vi.mocked(usePreferencesStore.getState).mockReturnValue(
      defaultPrefs({ aiGeneratedTitles: false }) as any,
    )
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', 'plain prose that would normally trigger titling')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
  })

  it('does not call generateTitle when isBusy (mid-turn steer)', () => {
    // A running tab has a non-default title so needsTitle is already false;
    // the !isBusy guard is belt-and-suspenders.
    const { state } = buildHarness(
      makeTab({ title: 'first prompt text', status: 'running', activeRequestId: 'req-1' }),
    )

    state.submit('tab-1', 'steer message during active run')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
  })

  it('recognizes a slash command with leading whitespace and skips LLM titling', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', '  /foo bar')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
  })

  it('fires LLM titling for submitRemotePrompt on a fresh tab with plain prose', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submitRemotePrompt('tab-1', 'ios user typed this message')

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1)
    expect(mockGenerateTitle).toHaveBeenCalledWith('ios user typed this message')
  })

  it('skips LLM titling for submitRemotePrompt when first prompt is a slash command', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submitRemotePrompt('tab-1', '/align some args')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
  })
})
