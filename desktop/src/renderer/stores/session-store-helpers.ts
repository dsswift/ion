import type { TabState, ThinkingEffort } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import { useModelStore } from './model-store'
import { defaultEffortForMode } from '../../shared/thinking-options'
import notificationSrc from '../../../resources/notification.mp3'
import type { FileEditorDirState } from './session-store-types'
import { tabHasExtensions } from '../../shared/tab-predicates'
import { rTrace } from '../rendererLogger'

const EDITABLE_EXTS = new Set(['.md', '.txt'])

const NON_TEXT_EXTS = new Set([
  '.csv', '.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.bmp', '.webp', '.tiff', '.zip', '.tar', '.gz', '.7z',
  '.rar', '.dmg', '.app', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
])

export function isTextFile(name: string): boolean {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return !NON_TEXT_EXTS.has(ext)
}

export function isEditableByDefault(name: string): boolean {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return EDITABLE_EXTS.has(ext)
}

export function editorDirForTab(tab: Pick<TabState, 'worktree' | 'workingDirectory'>): string {
  return tab.worktree?.repoPath ?? tab.workingDirectory
}

let editorFileCounter = 0
export const nextEditorFileId = () => `ef-${++editorFileCounter}`

export function nextUntitledNameFromNames(names: Iterable<string>): string {
  const used = new Set<number>()
  for (const name of names) {
    const match = name.match(/^Untitled-(\d+)\.md$/)
    if (match) used.add(Number(match[1]))
  }
  let n = 1
  while (used.has(n)) n++
  return `Untitled-${n}.md`
}

export function nextUntitledName(states: Map<string, FileEditorDirState>): string {
  return nextUntitledNameFromNames(
    [...states.values()].flatMap((state) => state.files.map((file) => file.fileName)),
  )
}

let msgCounter = 0
export const nextMsgId = () => `msg-${++msgCounter}`
export const peekMsgCounter = () => msgCounter
export const bumpMsgCounter = () => ++msgCounter

/**
 * The notification element, built on first play instead of at module load.
 *
 * `new Audio()` at import time made this module unloadable anywhere the DOM
 * constructor is absent, and this module is the home of `makeLocalTab` /
 * `nextMsgId` — which every store slice imports. Suites that only wanted a tab
 * factory therefore had to replace the whole module with a hand-written mock,
 * and each of those mocks then drifted from the real export list as helpers were
 * added. Constructing lazily keeps the import side-effect-free: the element is
 * created the first time a notification actually plays, in the renderer, where
 * the constructor exists.
 */
let notificationAudio: HTMLAudioElement | null = null

function resolveNotificationAudio(): HTMLAudioElement | null {
  if (notificationAudio) return notificationAudio
  if (typeof Audio !== 'function') return null
  notificationAudio = new Audio(notificationSrc)
  notificationAudio.volume = 1.0
  return notificationAudio
}

export async function playNotificationIfHidden(): Promise<void> {
  if (!usePreferencesStore.getState().soundEnabled) return
  const audio = resolveNotificationAudio()
  if (!audio) {
    rTrace('notify', 'notification skipped because the audio constructor is unavailable')
    return
  }
  try {
    const visible = await window.ion.isVisible()
    if (!visible) {
      audio.currentTime = 0
      audio.play().catch((err) => rTrace('notify', 'notification audio play rejected', { error: String(err) }))
    }
  } catch (err) {
    rTrace('notify', 'notification audio gate failed', { error: String(err) })
  }
}

/**
 * Read the user's preferred default permission mode from preferences.
 * Used at tab/instance creation time to seed the initial mode onto the
 * conversation instance (TabState no longer carries a permissionMode ghost
 * field — WI-002).
 */
export function initialPermissionMode(): 'auto' | 'plan' {
  return usePreferencesStore.getState().defaultPermissionMode ?? 'auto'
}

/**
 * Read the level a new conversation's thinking control should start at.
 * Used at tab/instance creation time to seed the instance, mirroring
 * `initialPermissionMode` above.
 *
 * Model-aware: a model whose capability mode is `adaptive` (Anthropic) starts
 * at `adaptive`, meaning "reason, but choose your own depth". Pinning an
 * explicit level on such a model overrides its per-turn judgment on EVERY
 * turn — including trivial ones — which is a large latency cost for no
 * quality gain, so it is a deliberate user choice rather than a default.
 * Effort-based models (reasoning_effort / gemini / budget) have no
 * self-regulation to defer to, so they take the user's configured default.
 *
 * `modelId` is the model the conversation will start on. When it is unknown or
 * not yet in the registry the configured default applies; the picker repairs
 * the value once the model resolves.
 */
export function initialThinkingEffort(modelId?: string | null): ThinkingEffort {
  const prefs = usePreferencesStore.getState()
  const configured: ThinkingEffort = prefs.defaultThinkingEffort ?? 'high'
  const id = modelId || prefs.preferredModel
  if (!id) return configured
  const entry = useModelStore.getState().findModel(id)
  return defaultEffortForMode(entry?.thinkingMode, configured)
}

export function makeLocalTab(): TabState {
  return {
    id: crypto.randomUUID(),
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    lastActivityAt: null,
    lastMessageAt: null,
    idleSince: null,
    createdAt: Date.now(),
    lastFailureAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    lastCompletionAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    manualUnread: false,
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
    workingDirectory: '~',
    hasChosenDirectory: false,
    lastMessagePreview: null,
    additionalDirs: [],
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    executionHost: null,
    executionMachineId: null,
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
  }
}

/**
 * Build the initial `modelOverride` for a normal tab's `main` conversation
 * instance: the planning-model split applies when the tab starts in plan mode
 * and the user has configured a plan-mode model. Returned separately from
 * `makeLocalTab` because model state now lives on the instance, not the tab —
 * the pane-seeding site passes this into `makeMainPane({ modelOverride })`.
 */
export function initialModelOverride(): string | null {
  const prefs = usePreferencesStore.getState()
  return prefs.planModelSplitEnabled && prefs.planModeModel && prefs.defaultPermissionMode === 'plan'
    ? prefs.planModeModel
    : null
}

/**
 * Reusable-blank-conversation detection — the new-tab DEDUP predicate.
 *
 * Answers: "should the new-tab action (createTab / createTabInDirectory)
 * REUSE this existing empty tab instead of spawning a duplicate blank?" When
 * the user requests a new tab and an untouched empty conversation tab already
 * exists for the same directory, the action focuses it rather than stacking up
 * a second identical blank. This never moves a conversation between tabs.
 *
 * `msgCount` is the tab's active-instance effective message count
 * (`instanceMessageCount` from conversation-instance.ts); callers resolve it
 * from `conversationPanes` since message state no longer lives on `TabState`. A
 * reusable blank has no messages, no custom title, and is anchored to `dir`.
 *
 * The `!tabHasExtensions(t)` clause is IDENTITY data, not the unified-behavior
 * divergence pattern: a harness-configured tab (carrying an `engineProfileId`)
 * is not a generic blank, and silently retargeting "new tab" into a configured
 * harness would be wrong. Excluding extension tabs from reuse is intended and
 * stays in parity.
 */
export function isReusableBlankConversationTab(t: TabState, dir: string, msgCount: number): boolean {
  return !t.isTerminalOnly && !tabHasExtensions(t) && msgCount === 0 && !t.customTitle && t.workingDirectory === dir
}

/**
 * Reusable-blank-terminal detection — the terminal-tab sibling of
 * {@link isReusableBlankConversationTab}. Answers whether a new terminal tab
 * request should reuse this untouched terminal-only tab for `dir` instead of
 * spawning a duplicate.
 */
export function isReusableBlankTerminalTab(t: TabState, dir: string): boolean {
  return t.isTerminalOnly && !t.customTitle && t.workingDirectory === dir
}

export function totalInputTokens(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): number {
  if (!usage) return 0
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}

// ── Pending done-group move timers ──────────────────────────────────────────
// When task_complete fires, the done-group move is scheduled with a short
// delay so the tab is visible in the in-progress group before moving to done.
// If the user re-sends before the timer fires, the send-slice cancels the
// pending move so the tab stays in in-progress.
const pendingDoneMoves = new Map<string, ReturnType<typeof setTimeout>>()

/** Schedule a done-group move for `tabId` after `delayMs`. */
export function scheduleDoneGroupMove(tabId: string, delayMs: number, callback: () => void): void {
  cancelDoneGroupMove(tabId)
  const timer = setTimeout(() => {
    pendingDoneMoves.delete(tabId)
    callback()
  }, delayMs)
  pendingDoneMoves.set(tabId, timer)
}

/** Cancel any pending done-group move for `tabId`. */
export function cancelDoneGroupMove(tabId: string): boolean {
  const timer = pendingDoneMoves.get(tabId)
  if (timer) {
    clearTimeout(timer)
    pendingDoneMoves.delete(tabId)
    return true
  }
  return false
}
