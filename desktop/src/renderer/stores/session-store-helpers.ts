import type { TabState } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import notificationSrc from '../../../resources/notification.mp3'
import type { FileEditorDirState } from './session-store-types'

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

export function editorDirForTab(tab: TabState): string {
  return tab.worktree?.repoPath ?? tab.workingDirectory
}

let editorFileCounter = 0
export const nextEditorFileId = () => `ef-${++editorFileCounter}`

export function nextUntitledName(states: Map<string, FileEditorDirState>): string {
  const used = new Set<number>()
  for (const state of states.values()) {
    for (const f of state.files) {
      const m = f.fileName.match(/^Untitled-(\d+)\.md$/)
      if (m) used.add(Number(m[1]))
    }
  }
  let n = 1
  while (used.has(n)) n++
  return `Untitled-${n}.md`
}

let msgCounter = 0
export const nextMsgId = () => `msg-${++msgCounter}`
export const peekMsgCounter = () => msgCounter
export const bumpMsgCounter = () => ++msgCounter

const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

export async function playNotificationIfHidden(): Promise<void> {
  if (!usePreferencesStore.getState().soundEnabled) return
  try {
    const visible = await window.ion.isVisible()
    if (!visible) {
      notificationAudio.currentTime = 0
      notificationAudio.play().catch(() => {})
    }
  } catch {}
}

export function makeLocalTab(): TabState {
  const prefs = usePreferencesStore.getState()
  const permissionMode = prefs.defaultPermissionMode
  return {
    id: crypto.randomUUID(),
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
    workingDirectory: '~',
    hasChosenDirectory: false,
    lastMessagePreview: null,
    additionalDirs: [],
    permissionMode,
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
    hasEngineExtension: false,
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
 * Blank-conversation detection. `msgCount` is the tab's active-instance
 * effective message count (`instanceMessageCount` from conversation-instance.ts);
 * callers resolve it from `conversationPanes` since message state no longer lives on
 * `TabState`. A blank conversation tab has no messages, no custom title, and is
 * anchored to `dir`.
 */
export function isBlankConversationTab(t: TabState, dir: string, msgCount: number): boolean {
  return !t.isTerminalOnly && !t.hasEngineExtension && msgCount === 0 && !t.customTitle && t.workingDirectory === dir
}

export function isBlankTerminalTab(t: TabState, dir: string): boolean {
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
