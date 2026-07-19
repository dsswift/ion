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
}

/** Per-sub-conversation instance projection (drives iOS EngineInstanceBar). */
export interface ProjectedConversationInstance {
  id: string
  label: string
  waitingState?: 'plan-ready' | 'question' | null
  isRunning?: boolean
  runningAgentCount?: number
  modelFallback?: { requestedModel: string; fallbackModel: string }
  conversationIds?: string[]
  thinkingEffort?: 'low' | 'medium' | 'high'
  dispatchTelemetry?: import('./types-engine').DispatchTelemetryEntry[]
}

/** Terminal instance metadata projection. */
export interface ProjectedTerminalInstance {
  id: string
  label: string
  kind: string
  readOnly: boolean
  cwd: string
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
  permissionMode: string
  permissionQueue: ProjectedPermissionEntry[]
  elicitationQueue: ProjectedElicitationEntry[]
  thinkingEffort?: string
  contextTokens: number | null
  contextWindow: number | null
  messageCount: number
  queuedPrompts: string[]
  isTerminalOnly?: boolean
  hasEngineExtension?: boolean
  engineProfileId: string | null
  conversationInstances?: ProjectedConversationInstance[]
  activeConversationInstanceId?: string | null
  terminalInstances?: ProjectedTerminalInstance[]
  activeTerminalInstanceId?: string | null
  groupId: string | null
  modelOverride: string | null
  groupPinned: boolean
  hasRunningChildren?: boolean
  conversationId: string | null
  lastMessageContent: string | null
  lastActivityTs: number
  convFingerprint: string
  pillColor: string | null
  pillIcon: string | null
  runCostUsd?: number
  conversationCostUsd?: number
  conversationTurns?: number
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
