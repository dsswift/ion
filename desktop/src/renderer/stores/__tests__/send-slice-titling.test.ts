/**
 * send-slice — send-time titling, for the conversation AND its worktree
 *
 * Pins the contract that ONE title generation fires at SEND TIME (in parallel
 * with the run), not at task_complete, and that its single result names both the
 * tab and — when the conversation is running in a worktree that has no name yet
 * — the worktree. The title is derived from the user's first message, which is
 * available instantly at submit(), so there is no reason to wait for turn
 * completion.
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
 *   9. The ONE generated string reaches both the tab and the worktree seed.
 *  10. A slash command seeds nothing — it is an operation, not a description.
 *  11. Failed title generation keeps fallback, skips seed, and logs a warning.
 *
 * Regression direction for case 1: removing the slash guard in
 * event-slice-titling.ts causes generateTitle to be called and case 1 goes red.
 * Regression direction for case 2: removing the maybeSendTimeTitle call from
 * send-slice.ts causes generateTitle never to be called and case 2 goes red.
 * Regression direction for case 9: a second generateTitle call for the worktree
 * (the drift this design removed) turns the call-count assertion red.
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
      tabGroups: [],
    })),
  },
}))

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(),
  rWarn: vi.fn(),
}))

import { usePreferencesStore } from '../../preferences'
import { rWarn } from '../../rendererLogger'
import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockGenerateTitle = vi.fn(async () => '')
const mockSaveSessionLabel = vi.fn(async () => {})
const mockTabMetaChanged = vi.fn()
const mockWorktreeSeedTitle = vi.fn(async () => ({ ok: false, reason: 'not-a-worktree' as const }))

;(globalThis as any).window = {
  ion: {
    prompt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(),
    steer: vi.fn(),
    generateTitle: mockGenerateTitle,
    saveSessionLabel: mockSaveSessionLabel,
    tabMetaChanged: mockTabMetaChanged,
    gitWorktreeSeedTitle: mockWorktreeSeedTitle,
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
  state.renameTab = vi.fn((tabId: string, title: string) => {
    state.tabs = state.tabs.map((t: TabState) =>
      t.id === tabId ? { ...t, customTitle: title } : t,
    )
  })
  return { state, get }
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

  it('does not re-title a restored tab that has a customTitle but a stale placeholder title', () => {
    // Post-engine-restore shape: the AI title was persisted and restored into
    // customTitle, but tab.title still carries the 'New Tab' sentinel that
    // createConversationTab seeded (the engine restore path never mirrors
    // tab.title). A mid-conversation prompt must NOT re-fire titling.
    const { state } = buildHarness(
      makeTab({ title: 'New Tab', customTitle: 'Real AI Title' }),
    )

    state.submit('tab-1', 'a mid-conversation prompt about something else')

    expect(mockGenerateTitle).not.toHaveBeenCalled()
    expect(state.tabs[0].customTitle).toBe('Real AI Title')
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

/**
 * Worktree naming rides the tab-titling round-trip: ONE generated string names
 * both, at the same moment.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Worktree naming used to be a SECOND `generateTitle` call over the same prompt,
 * fired on every send. Two round-trips over one prompt produced two
 * independently-worded names for one piece of work, and they drifted from the
 * moment they were written. The worktree is now SEEDED with the string generated
 * for the tab, so the two cannot disagree.
 *
 * ── Where idempotency lives ─────────────────────────────────────────────────
 * The seed rides the `needsTitle && !isBusy` guard, so it fires on a
 * conversation's FIRST prompt. Several conversations routinely share one
 * worktree, and each of their first sends reaches here — the main process
 * refuses a seed for a worktree that already has a name, so whichever
 * conversation prompts first names it ("first prompt wins"). That decision lives
 * against the registry, not here.
 *
 * Regression direction: a second generateTitle call for the worktree turns the
 * call-count assertion red; seeding a slash command turns the operation case
 * red.
 */
describe('send-slice — worktree seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePreferencesStore.getState).mockReturnValue(defaultPrefs() as any)
  })

  // THE assertion of this design: one generation, one string, both surfaces.
  it('seeds the worktree with the SAME string it gave the tab, from ONE generation', async () => {
    mockGenerateTitle.mockResolvedValueOnce('Fix the token expiry check' as any)
    const { state, get } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))

    state.submit('tab-1', 'the auth middleware rejects valid tokens')
    await vi.waitFor(() => expect(mockWorktreeSeedTitle).toHaveBeenCalled())

    // Exactly one round-trip — a second would be the drift this removed.
    expect(mockGenerateTitle).toHaveBeenCalledTimes(1)
    expect(mockGenerateTitle).toHaveBeenCalledWith('the auth middleware rejects valid tokens')
    // The tab got it...
    expect(get().tabs.find((t) => t.id === 'tab-1')?.customTitle).toBe('Fix the token expiry check')
    // ...and the worktree got the same string, not a separately-worded one.
    expect(mockWorktreeSeedTitle).toHaveBeenCalledWith('/wt/ion-a3f1', 'Fix the token expiry check')
  })

  /**
   * A slash command is an OPERATION, not a description of the work. It never
   * names anything: the tab keeps the literal command it was given at send time,
   * and the worktree stays on its slug until a real prompt arrives.
   */
  it('seeds nothing for a slash command, which is an operation not a description', async () => {
    const { state } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))

    state.submit('tab-1', '/align')
    await Promise.resolve()

    expect(mockGenerateTitle).not.toHaveBeenCalled()
    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
  })

  /**
   * The inverse of the old rule, and the assertion that would go red if seeding
   * were wired back OUTSIDE the `needsTitle` guard.
   *
   * A conversation that already has a title is not a naming event. Under the old
   * design this fired on every send so a nameless worktree could be rescued by
   * any conversation at any time; now the worktree is named at creation or by
   * the first conversation to prompt in it, so a later send has nothing to say.
   */
  it('seeds nothing when the TAB already has a title', async () => {
    const { state } = buildHarness(
      makeTab({ title: 'An existing tab title', workingDirectory: '/wt/ion-a3f1' }),
    )

    state.submit('tab-1', 'a later prompt in an already-titled conversation')
    await Promise.resolve()

    expect(mockGenerateTitle).not.toHaveBeenCalled()
    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
  })

  it('keeps truncated fallback, skips worktree seed, and warns when title generation rejects', async () => {
    const error = new Error('title service unavailable')
    mockGenerateTitle.mockRejectedValueOnce(error)
    const { state } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))
    const prompt = 'plain prose that should remain the fallback title after title generation fails'
    const fallback = `${prompt.substring(0, 37)}...`

    state.submit('tab-1', prompt)
    await vi.waitFor(() => expect(vi.mocked(rWarn)).toHaveBeenCalled())

    expect(state.tabs[0].title).toBe(fallback)
    expect(state.tabs[0].customTitle).toBeNull()
    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
    expect(rWarn).toHaveBeenCalledWith(
      'event.title',
      'AI title generation failed; keeping truncated fallback',
      { tab_id: 'tab-1', error: 'Error: title service unavailable' },
    )
  })

  it('seeds nothing when generation returns an empty title', async () => {
    // The engine returns "" when no titling model is configured — a legitimate
    // configuration. Nothing to apply, so nothing to seed.
    mockGenerateTitle.mockResolvedValueOnce('' as any)
    const { state } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))

    state.submit('tab-1', 'plain prose that generates nothing')
    await vi.waitFor(() => expect(mockGenerateTitle).toHaveBeenCalled())

    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
  })

  it('respects the aiGeneratedTitles preference', async () => {
    vi.mocked(usePreferencesStore.getState).mockReturnValue(
      defaultPrefs({ aiGeneratedTitles: false }) as any,
    )
    const { state } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))

    state.submit('tab-1', 'plain prose that would normally trigger titling')
    await Promise.resolve()

    expect(mockGenerateTitle).not.toHaveBeenCalled()
    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
  })

  it('does not seed for a tab with no directory at all', async () => {
    // '~' is the "no project root" sentinel, not a place. Everything else —
    // including a resolved home path — goes to the main process, which owns
    // the "is this a registered worktree?" decision against the registry
    // rather than having each renderer guess from the path shape.
    mockGenerateTitle.mockResolvedValueOnce('A generated name' as any)
    const { state } = buildHarness(
      makeTab({ title: 'New Tab', workingDirectory: '~', hasChosenDirectory: true }),
    )

    state.submit('tab-1', 'plain prose with no project root')
    await vi.waitFor(() => expect(mockGenerateTitle).toHaveBeenCalled())

    expect(mockWorktreeSeedTitle).not.toHaveBeenCalled()
  })

  it('lets the main process answer for an ordinary project directory', async () => {
    mockGenerateTitle.mockResolvedValueOnce('A generated name' as any)
    const { state } = buildHarness(
      makeTab({ title: 'New Tab', workingDirectory: '/home/test/src/ion' }),
    )

    state.submit('tab-1', 'plain prose in a normal project tab')
    await vi.waitFor(() => expect(mockWorktreeSeedTitle).toHaveBeenCalled())

    // Fired, and the main process replies `not-a-worktree` — one registry
    // lookup, no extra generation. Deciding here instead would mean each window
    // guessing from its own possibly-stale inventory snapshot.
    expect(mockWorktreeSeedTitle).toHaveBeenCalledWith('/home/test/src/ion', 'A generated name')
  })

  it('seeds on the iOS send path too', async () => {
    mockGenerateTitle.mockResolvedValueOnce('Work the phone described' as any)
    const { state } = buildHarness(makeTab({ title: 'New Tab', workingDirectory: '/wt/ion-a3f1' }))

    state.submitRemotePrompt('tab-1', 'ios user described the work')
    await vi.waitFor(() => expect(mockWorktreeSeedTitle).toHaveBeenCalled())

    expect(mockGenerateTitle).toHaveBeenCalledTimes(1)
    expect(mockWorktreeSeedTitle).toHaveBeenCalledWith('/wt/ion-a3f1', 'Work the phone described')
  })
})
