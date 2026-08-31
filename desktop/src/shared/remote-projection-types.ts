/**
 * remote-projection-types — cross-process shapes for the renderer-push
 * snapshot projection.
 *
 * The renderer projects `ProjectedRendererTab[]` from its session store
 * (renderer/stores/remote-projection.ts) and pushes the result to the main
 * process over IPC (IPC.REMOTE_TAB_STATES_PUSH). The main process caches the
 * payload (state.rendererSnapshotCache) and serves it from
 * `getRemoteTabStates()` (main/remote/snapshot.ts), which maps it onto the
 * wire `RemoteTabState` via `projectRendererTab` (main/remote/snapshot-project.ts).
 *
 * These types live in shared/ because both processes consume them: the
 * renderer produces the payload, the main process validates and caches it.
 */

/** Per-kind resource metadata manifest included in remote snapshots. */
export type ResourceManifest = Record<string, Array<{
  id: string
  kind: string
  producer?: string
  title?: string
  createdAt: string
  read?: boolean
  conversationId?: string
}>>

/**
 * A raw permission-queue entry as projected from the renderer store. Two
 * sources merge into one queue:
 *   - live interactive requests (PermissionRequest shape: toolTitle + options)
 *   - promoted non-interactive denials (synthesized `denied-<toolUseId>`
 *     entries carrying toolName/toolTitle and empty options)
 * The main-process mapping (snapshot.ts) normalizes both onto the wire shape.
 */
export interface ProjectedPermissionEntry {
  questionId: string
  toolTitle?: string
  toolName?: string
  toolDescription?: string
  toolInput?: Record<string, unknown>
  options: Array<{ optionId?: string; kind?: string; label?: string }>
  /** Engine instance (sub-tab) scope for extension-hosted tabs. */
  instanceId?: string | null
}

/** Live extension elicitation entry projected from the active instance. */
export interface ProjectedElicitationEntry {
  requestId: string
  mode?: string
  schema?: Record<string, unknown>
  url?: string
  source?: string
  server?: string
  message?: string
  action?: string
}

/** Per-sub-conversation instance projection (drives iOS EngineInstanceBar). */
export interface ProjectedConversationInstance {
  id: string
  label: string
  waitingState?: 'plan-ready' | 'question' | null
  isRunning?: boolean
  /** Engine session is attaching without a foreground run. */
  isStarting?: boolean
  runningAgentCount?: number
  /** LIVE background bash processes this instance owns, notifying or detached
   *  — the fold of `statusFields.backgroundShells` and
   *  `statusFields.activeBackgroundTasks` (see shared/background-shell-counts.ts).
   *  The shell counterpart to runningAgentCount; drives the iOS pink shell dot. */
  backgroundShellCount?: number
  activeBackgroundTasks?: import('./types-engine').BackgroundTaskState[]
  modelFallback?: { requestedModel: string; fallbackModel: string }
  conversationIds?: string[]
  thinkingEffort?: 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  dispatchTelemetry?: import('./types-engine').DispatchTelemetryEntry[]
}

/** Terminal instance metadata projection. */
export interface ProjectedTerminalInstance {
  id: string
  label: string
  kind: string
  readOnly: boolean
  cwd: string
  isRunning?: boolean
  processLabel?: string
  applications?: import('./terminal-activity').TerminalWebApplication[]
}

/**
 * One tab as projected by the renderer. Field-for-field this is the shape the
 * legacy snapshot `executeJavaScript` IIFE produced; the main-process
 * `projectRendererTab` consumes it (via RendererTabInput) to build the wire
 * RemoteTabState. Optional/undefined fields are omitted on the wire.
 */
export interface ProjectedRendererTab {
  id: string
  title: string
  customTitle: string | null
  status: string
  workingDirectory: string
  executionHost?: string
  executionMachineId?: string
  permissionMode: string
  permissionQueue: ProjectedPermissionEntry[]
  elicitationQueue: ProjectedElicitationEntry[]
  thinkingEffort?: string
  contextTokens: number | null
  contextWindow: number | null
  messageCount: number
  queuedPrompts: string[]
  isTerminalOnly?: boolean
  /** Input-locked conversation (auto-generated conflict fix, sealed landed worktree, or settled). */
  inputLocked?: boolean
  inputLockReason?: 'automated-workflow' | 'landed-worktree' | 'settled' | null
  /** Explicit tab lifecycle role. See TabState.tabRole. */
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis'
  hasEngineExtension?: boolean
  engineProfileId: string | null
  conversationInstances?: ProjectedConversationInstance[]
  activeConversationInstanceId?: string | null
  terminalInstances?: ProjectedTerminalInstance[]
  activeTerminalInstanceId?: string | null
  hasRunningTerminal?: boolean
  terminalApplications?: import('./terminal-activity').TerminalWebApplication[]
  groupId: string | null
  modelOverride: string | null
  groupPinned: boolean
  hasRunningChildren?: boolean
  /** Summed outstanding background bash commands across instances. Drives
   *  the iOS parent tab pill's pink shell dot. Omitted at zero. */
  backgroundShellCount?: number
  /** Exact engine status signal: background/delivery work still blocks settle. */
  hasPendingWork?: boolean
  conversationId: string | null
  /** Complete canonical engine session chain, oldest to newest. */
  sessionIds?: string[]
  lastMessageContent: string | null
  /**
   * DERIVED conversation activity key: newest transcript row, persisted
   * activity, message, or run completion. Reconnect heartbeats never advance it.
   */
  lastActivityTs: number
  /** Last running→idle transition (renderer-observed, restored verbatim). */
  idleSince: number | null
  /** Immutable creation timestamp — the "Newest created" inbox sort key. */
  createdAt?: number
  /**
   * Explicit worktree identity when the tab lives in a managed worktree.
   * Clients group by THIS, never by path-prefix guessing: a worktree that has
   * not reached the inventory yet (freshly created) still groups under its
   * source repository, exactly as the desktop navigator does.
   */
  worktree?: {
    worktreePath: string
    branchName: string
    sourceBranch: string
    repoPath: string
    landedAt?: number
  }
  /** Desktop-derived inbox classification (iOS renders, never re-derives). */
  inboxState: 'active' | 'snoozed' | 'settled'
  /** Inbox unread derivation (manualUnread || completion > visit). */
  unread: boolean
  snoozedUntil: number | null
  settledAt: number | null
  /**
   * False when settling this conversation is TERMINAL — no route back to an
   * active conversation. Desktop-derived (clients render, never re-derive): a
   * bench conversation's checkout is rebuilt underneath it and a machine
   * conversation cannot be typed in, so Un-settle must be absent on every
   * client. Omitted when the answer is "restorable", which is what a client
   * assumes for an absent value.
   */
  canRestoreSettled?: boolean
  /** Woke-pill moment (expired snooze not yet visited). */
  wokeAt: number | null
  /** Pin metadata and derived background liveness for inbox client parity. */
  pinnedAt?: number | null
  pinOrderKey?: string | null
  backgroundLiveness?: 'working' | 'monitoring'
  convFingerprint: string
  pillColor: string | null
  pillIcon: string | null
  runCostUsd?: number
  conversationCostUsd?: number
  conversationTurns?: number
  lastRunDurationMs?: number
  lastRunReason?: import('./types-events').TaskCompletionReason | (string & {})
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/** The payload the renderer pushes over IPC.REMOTE_TAB_STATES_PUSH. */
export interface RemoteTabStatesPayload {
  tabs: ProjectedRendererTab[]
  resourceManifest: ResourceManifest
}

/** Main-process cache entry for the last renderer-pushed projection. */
export interface RendererSnapshotCache extends RemoteTabStatesPayload {
  /** Wall-clock ms when the push arrived. Freshness gate in getRemoteTabStates. */
  receivedAt: number
}
