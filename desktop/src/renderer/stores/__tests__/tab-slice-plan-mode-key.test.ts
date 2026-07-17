/**
 * tab-slice setPermissionMode — engine session-key regression test.
 *
 * Pins the #256-followup fix: on an extension-hosted (engineProfileId) tab,
 * setPermissionMode must call window.ion.engineSetPlanMode with the BARE
 * tabId, not the old compound `${tabId}:${instanceId}` key.
 *
 * After session-key unification (#256) the engine keys sessions by the bare
 * tabId (sessionKey() returns tabId), and SetPlanMode looks up
 * m.sessions[key] (engine/internal/session/plan_mode.go). The compound key
 * missed the map and silently no-op'd, so plan-mode toggling was broken on
 * extension-hosted tabs.
 *
 * Reverting the fix (passing `${activeTabId}:${instanceId}`) makes the
 * "bare key" assertions below go red — this test distinguishes the fixed
 * behavior from the broken one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({ id: 'mock-tab' })),
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
      tabGroups: [{ id: 'group-default', label: 'Default', isDefault: true, order: 0 }],
    })),
  },
  getEffectiveTabGroups: vi.fn(() => [
    { id: 'group-default', label: 'Default', isDefault: true, order: 0 },
  ]),
}))

import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockEngineSetPlanMode = vi.fn()
const mockSetPermissionMode = vi.fn()
;(globalThis as any).window = {
  ion: {
    engineSetPlanMode: mockEngineSetPlanMode,
    setPermissionMode: mockSetPermissionMode,
  },
  crypto: { randomUUID: () => 'uuid-1234' },
}

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1', conversationId: null, historicalSessionIds: [], lastKnownSessionId: null,
    status: 'idle', activeRequestId: null, lastEventAt: null, hasUnread: false, currentActivity: '',
    attachments: [], title: 'New Tab', customTitle: null, lastResult: null, sessionTools: [],
    sessionMcpServers: [], sessionSkills: [], sessionVersion: null, queuedPrompts: [],
    workingDirectory: '/home/test', hasChosenDirectory: true, additionalDirs: [],
    bashResults: [], bashExecuting: false, bashExecId: null, pillColor: null, pillIcon: null,
    forkedFromSessionId: null, hasFileActivity: false, worktree: null, pendingWorktreeSetup: false,
    groupId: null, groupPinned: false, contextTokens: null, contextPercent: null, contextWindow: null,
    isCompacting: false, isTerminalOnly: false, engineProfileId: null, lastMessagePreview: null,
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
    conversationPanes: seedMainPane(initialTab.id, { ...instanceOverrides }),
  }

  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })
  const get = () => state as State

  const tabSlice = createTabSlice(set, get)
  Object.assign(state, tabSlice)
  return { state }
}

describe('setPermissionMode — engine session key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the bare tabId to engineSetPlanMode when entering plan mode on an extension-hosted tab', () => {
    const { state } = buildHarness(makeTab({ engineProfileId: 'profile-x' }))

    state.setPermissionMode('plan', 'user')

    expect(mockEngineSetPlanMode).toHaveBeenCalledWith('tab-1', true)
    // The old compound key form must never be sent.
    expect(mockEngineSetPlanMode).not.toHaveBeenCalledWith('tab-1:main', expect.anything())
  })

  it('passes the bare tabId to engineSetPlanMode when leaving plan mode on an extension-hosted tab', () => {
    const { state } = buildHarness(makeTab({ engineProfileId: 'profile-x' }), {
      permissionMode: 'plan',
    })

    state.setPermissionMode('auto', 'user')

    expect(mockEngineSetPlanMode).toHaveBeenCalledWith('tab-1', false)
    expect(mockEngineSetPlanMode).not.toHaveBeenCalledWith('tab-1:main', expect.anything())
  })

  it('routes plain (non-engine) tabs through setPermissionMode, not engineSetPlanMode', () => {
    const { state } = buildHarness(makeTab({ engineProfileId: null }))

    state.setPermissionMode('plan', 'user')

    expect(mockEngineSetPlanMode).not.toHaveBeenCalled()
    expect(mockSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'user', undefined)
  })
})
