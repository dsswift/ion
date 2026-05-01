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
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    title: 'New Tab',
    customTitle: null,
    lastResult: null,
    sessionModel: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: usePreferencesStore.getState().defaultPermissionMode,
    planFilePath: null,
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
    contextTokens: null,
    contextPercent: null,
    isTerminalOnly: false,
    isEngine: false,
    engineProfileId: null,
  }
}

export function isBlankConversationTab(t: TabState, dir: string): boolean {
  return !t.isTerminalOnly && t.messages.length === 0 && !t.customTitle && t.workingDirectory === dir
}

export function isBlankTerminalTab(t: TabState, dir: string): boolean {
  return t.isTerminalOnly && !t.customTitle && t.workingDirectory === dir
}

export function totalInputTokens(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): number {
  if (!usage) return 0
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}
