import type { TabState, ThinkingEffort } from '@ion/shared/types'
import { clientPreferences } from './client-preferences'
import { PERSONAL_PREFERENCE_DEFAULTS, type PersonalPreferences } from '@ion/shared/settings-registry'
import { isThinkingEffort } from '@ion/shared/thinking-options'
import { usePreferencesStore } from '../persistence/preferences'
import { useModelStore } from './model-store'
import { defaultEffortForMode } from '@ion/shared/thinking-options'
import notificationSrc from '../../resources/notification.mp3'
import type { FileEditorDirState } from './session-store-types'
import { tabHasExtensions } from '@ion/shared/tab-predicates'
import { rInfo, rTrace } from './rendererLogger'
import { isVisible } from './host-api'
import { currentPrincipal, currentPreferences } from '../identity/request-principal'

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

/**
 * A random scope minted once per loaded copy of this module.
 *
 * Every process that loads this store mints row ids on its own, and those ids
 * cross process boundaries: a row one process created is published to another
 * that already holds rows of its own. A bare counter restarts at 1 in each
 * process, so two unrelated rows could share "msg-N", and a receiver that
 * dedups by id then drops the incoming row as one it already has. The scope
 * makes the ids of two processes disjoint. `getRandomValues` is used rather
 * than `randomUUID` because it is also available outside a secure context.
 */
const msgIdScope = (() => {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
})()
let msgCounter = 0
/** A locally minted row id. The `msg-` prefix marks it as not yet canonical. */
export const nextMsgId = () => `msg-${msgIdScope}-${++msgCounter}`

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
  if (!clientPreferences().soundEnabled) return
  const audio = resolveNotificationAudio()
  if (!audio) {
    rTrace('notify', 'notification skipped because the audio constructor is unavailable')
    return
  }
  try {
    const visible = await isVisible()
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
  const declared = currentPreferences()?.defaultPermissionMode
  const mode = creatingClientPreferences().defaultPermissionMode
  // Both sides of the fallback: a conversation that starts in the wrong mode
  // is either a client that declared that mode or a client that declared
  // nothing, and only the log distinguishes them.
  rInfo('preferences', 'initial permission mode resolved', { mode, source: declared ? 'client' : 'default' })
  return mode
}

/**
 * The Personal preferences of the client creating a conversation right now,
 * registry defaults filling what it did not declare. They come with the
 * request (identity/request-principal.ts); the server keeps no settings copy
 * of a Personal preference to read instead.
 */
function creatingClientPreferences(): Required<PersonalPreferences> {
  return { ...PERSONAL_PREFERENCE_DEFAULTS, ...(currentPreferences() ?? {}) }
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
  // 'adaptive' is not a level a person configures: adaptive models derive
  // their own default below, and it would be meaningless on any other.
  const declared = creatingClientPreferences().defaultThinkingEffort
  const configured: ThinkingEffort = isThinkingEffort(declared) && declared !== 'adaptive' ? declared : 'medium'
  const id = modelId || prefs.preferredModel
  if (!id) return configured
  const entry = useModelStore.getState().findModel(id)
  return defaultEffortForMode(entry?.thinkingMode, configured)
}

export function makeLocalTab(): TabState {
  // Stamped once, at creation, from the ambient request principal (P0 --
  // see identity/request-principal.ts). `undefined` outside a Studio-wire
  // dispatch (the desktop's own local IPC, or this same code running in the
  // Studio renderer against the LOCAL environment) leaves the field unset,
  // matching every pre-partitioning tab's shape exactly.
  const subject = currentPrincipal()?.subject
  return {
    id: crypto.randomUUID(),
    ...(subject ? { principalSubject: subject } : {}),
    // The creating client's Personal preferences (conversation-preferences.ts).
    // Always an object: a restored tab WITHOUT one is how a pre-upgrade
    // conversation is recognised.
    conversationPreferences: { ...(currentPreferences() ?? {}) },
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
    forkedFromSessionId: null,
    executionHost: null,
    executionMachineId: null,
    worktree: null,
    pendingWorktreeSetup: false,
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
  return prefs.planModelSplitEnabled && prefs.planModeModel && initialPermissionMode() === 'plan'
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
