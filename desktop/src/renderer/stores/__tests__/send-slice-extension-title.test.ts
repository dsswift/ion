/**
 * send-slice — extension-tab first-prompt titling (unified seed).
 *
 * Pins that titling behaves identically for plain and extension-backed
 * conversations once the tab is seeded with the neutral 'New Tab' placeholder
 * (the unified-seed fix in engine-slice-create.ts). The send-time fallback in
 * `submit` replaces that placeholder with the first prompt's text:
 *   - slash first prompt  → literal `/command` becomes the title
 *   - prose first prompt   → truncated prose becomes the title
 * and a user-renamed tab (customTitle set) is never overwritten.
 *
 * Regression direction: the root cause was extension tabs being BORN with the
 * profile name as their title instead of 'New Tab'. The final test reproduces
 * that pre-fix seed and asserts the title then does NOT change — documenting
 * exactly why the seed must be the neutral placeholder. If the profile-name
 * seed is restored in engine-slice-create.ts, real extension tabs regress to
 * that broken state.
 *
 * These exercise `submit` directly (the single unified send path for every tab
 * kind); the only thing that makes a tab "extension-backed" here is a non-null
 * engineProfileId, exactly as in production.
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
      // An extension profile so an engine tab can resolve its extensions.
      engineProfiles: [{ id: 'profile-1', name: 'Ion', extensions: ['ext-a'] }],
      engineDefaultModel: null,
      thinkingEnabled: false,
      tabGroups: [],
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
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    // Extension-backed by default in this suite: a resolvable profile id is the
    // ONLY thing that distinguishes an extension tab from a plain one.
    engineProfileId: 'profile-1',
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
  return { state }
}

describe('send-slice — extension-tab first-prompt titling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('sets the literal /command as the title on a slash first prompt (extension tab)', () => {
    // Born with the unified neutral placeholder (matches the create-path seed).
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', '/align')

    expect(state.tabs[0].title).toBe('/align')
  })

  it('sets the truncated prose as the title on a prose first prompt (extension tab)', () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab' }))

    state.submit('tab-1', 'refactor the parser')

    expect(state.tabs[0].title).toBe('refactor the parser')
  })

  it('does not overwrite a user-renamed extension tab (customTitle set)', () => {
    const { state } = buildHarness(
      makeTab({ title: 'My Renamed Tab', customTitle: 'My Renamed Tab' }),
    )

    state.submit('tab-1', '/align')

    // needsTitle is false because the title is not the neutral placeholder, and
    // the user's customTitle is untouched.
    expect(state.tabs[0].title).toBe('My Renamed Tab')
    expect(state.tabs[0].customTitle).toBe('My Renamed Tab')
  })

  it('REGRESSION: a tab born with the profile name (pre-fix seed) never gets titled', () => {
    // This is the bug the unified seed fixes. If engine-slice-create.ts is
    // reverted to seed `profile.name`, real extension tabs land in exactly this
    // state and the first prompt's title is silently dropped.
    const { state } = buildHarness(makeTab({ title: 'Ion' }))

    state.submit('tab-1', '/align')

    // The profile-name seed is not the neutral placeholder, so needsTitle is
    // false and the literal /command is lost — the title stays 'Ion'.
    expect(state.tabs[0].title).toBe('Ion')
  })
})
