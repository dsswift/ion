/**
 * Pure helper that projects one renderer tab shape onto the wire
 * `RemoteTabState` shape sent to iOS clients.
 *
 * Extracts the pure field-mapping contract into a testable helper; the caller
 * (snapshot.ts) passes the two impure inputs (`lastMessage` from
 * `lastMessagePreview.get`, `permissionQueue` after plan-preview enrichment)
 * so this function has no side effects and can be unit-tested directly.
 *
 * The helper does NOT perform:
 *   - `lastMessagePreview.get(t.id)` — caller resolves and passes as
 *     `lastMessage`
 *   - `readPlanPreviewCached(...)` — caller enriches the queue entries
 *     before passing `permissionQueue`
 *
 * Field projection rules mirror the inline `mapped` block in snapshot.ts.
 */

import type { RemoteTabState } from './protocol'

export interface RendererTabInput {
  id: string
  title?: string
  customTitle?: string | null
  status?: string
  workingDirectory?: string
  executionHost?: string
  executionMachineId?: string
  permissionMode?: string
  thinkingEffort?: string | null
  contextTokens?: number | null
  contextWindow?: number | null
  messageCount?: number
  queuedPrompts?: string[]
  isTerminalOnly?: boolean
  inputLocked?: boolean
  inputLockReason?: 'automated-workflow' | 'landed-worktree' | 'settled' | null
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis' | null
  hasEngineExtension?: boolean
  /** Engine profile id — non-null for extension-hosted tabs. iOS uses this
   *  to resolve the harness badge display name from desktop_engine_profiles.
   *  Without this field, iOS falls back to the literal "EXT" badge label. */
  engineProfileId?: string | null
  conversationInstances?: RemoteTabState['conversationInstances']
  activeConversationInstanceId?: string | null
  terminalInstances?: RemoteTabState['terminalInstances']
  activeTerminalInstanceId?: string | null
  hasRunningTerminal?: boolean
  terminalApplications?: RemoteTabState['terminalApplications']
  groupId?: string | null
  modelOverride?: string | null
  groupPinned?: boolean
  hasRunningChildren?: boolean
  backgroundShellCount?: number
  hasPendingWork?: boolean
  conversationId?: string | null
  lastActivityTs?: number
  idleSince?: number | null
  createdAt?: number
  worktree?: RemoteTabState['worktree']
  inboxState?: 'active' | 'snoozed' | 'settled'
  unread?: boolean
  snoozedUntil?: number | null
  settledAt?: number | null
  settledOverride?: 'settled' | 'active' | 'auto' | null
  canRestoreSettled?: boolean
  wokeAt?: number | null
  pinnedAt?: number | null
  pinOrderKey?: string | null
  backgroundLiveness?: 'working' | 'monitoring'
  convFingerprint?: string
  pillColor?: string | null
  pillIcon?: string | null
  /**
   * Cost of the most recent run in USD (cache-aware, descendants included).
   * Projected to iOS so the cost indicator is accurate on cold open without
   * waiting for a live engine_status event. Undefined when the tab has never
   * had a run.
   */
  runCostUsd?: number
  /**
   * Cumulative cost of the entire conversation (this session + all descendant
   * dispatches) in USD. Undefined when the tab has never had a run.
   */
  conversationCostUsd?: number
  conversationTurns?: number
  lastRunDurationMs?: number
  lastRunReason?: import('../../shared/types-events').TaskCompletionReason | (string & {})
  /** Cumulative provider-reported input tokens. Undefined on never-run tabs. */
  inputTokens?: number
  /** Cumulative output tokens. Undefined on never-run tabs. */
  outputTokens?: number
  /** Cumulative cache-read tokens (Anthropic prompt caching). Optional. */
  cacheReadTokens?: number
  /** Cumulative cache-creation tokens (Anthropic prompt caching). Optional. */
  cacheCreationTokens?: number
}

export interface ProjectRendererTabOptions {
  /** Pre-resolved last message string. Caller provides `lastMessageContent`
   *  from the renderer tab merged with the `lastMessagePreview` map fallback. */
  lastMessage: string | null
  /** Pre-enriched permission queue. Caller handles the `ExitPlanMode`
   *  plan-preview enrichment before passing here. */
  permissionQueue: RemoteTabState['permissionQueue']
  /** Active instance's extension elicitation queue (ctx.elicit). Projected
   *  straight from the renderer; empty array when none pending. */
  elicitationQueue?: RemoteTabState['elicitationQueue']
}

/**
 * Projects a renderer tab shape onto the wire `RemoteTabState`. Pure —
 * no I/O, no store access. Caller resolves both impure inputs and passes
 * them explicitly via `opts`.
 */
export function projectRendererTab(
  t: RendererTabInput,
  opts: ProjectRendererTabOptions,
): RemoteTabState {
  return {
    id: t.id,
    title: t.customTitle || t.title || 'Tab',
    customTitle: t.customTitle || null,
    status: (t.status || 'idle') as RemoteTabState['status'],
    workingDirectory: t.workingDirectory || '',
    executionHost: t.executionHost || undefined,
    executionMachineId: t.executionMachineId || undefined,
    permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
    thinkingEffort: (t.thinkingEffort && t.thinkingEffort !== 'off')
      ? t.thinkingEffort as 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      : undefined,
    permissionQueue: opts.permissionQueue,
    elicitationQueue: opts.elicitationQueue ?? [],
    lastMessage: opts.lastMessage,
    contextTokens: t.contextTokens || null,
    contextWindow: t.contextWindow ?? null,
    messageCount: t.messageCount || 0,
    queuedPrompts: t.queuedPrompts || [],
    isTerminalOnly: t.isTerminalOnly || undefined,
    inputLocked: t.inputLocked || undefined,
    inputLockReason: t.inputLockReason || undefined,
    tabRole: t.tabRole || undefined,
    hasEngineExtension: t.hasEngineExtension || undefined,
    // iOS resolves the harness badge display name by matching
    // engineProfileId against the desktop_engine_profiles list.
    // Without this field, the badge falls back to literal "EXT".
    engineProfileId: t.engineProfileId || null,
    conversationInstances: t.conversationInstances || undefined,
    activeConversationInstanceId: t.activeConversationInstanceId || undefined,
    terminalInstances: t.terminalInstances || undefined,
    activeTerminalInstanceId: t.activeTerminalInstanceId || undefined,
    hasRunningTerminal: t.hasRunningTerminal || undefined,
    terminalApplications: t.terminalApplications || undefined,
    groupId: t.groupId || null,
    modelOverride: t.modelOverride || null,
    groupPinned: t.groupPinned || false,
    hasRunningChildren: t.hasRunningChildren || undefined,
    backgroundShellCount: t.backgroundShellCount || undefined,
    hasPendingWork: t.hasPendingWork || undefined,
    conversationId: t.conversationId || undefined,
    lastActivityAt: t.lastActivityTs || undefined,
    idleSince: t.idleSince || undefined,
    createdAt: t.createdAt || undefined,
    worktree: t.worktree || undefined,
    inboxState: t.inboxState || undefined,
    unread: t.unread,
    snoozedUntil: t.snoozedUntil || undefined,
    settledAt: t.settledAt || undefined,
    settledOverride: t.settledOverride || undefined,
    canRestoreSettled: t.canRestoreSettled,
    wokeAt: t.wokeAt || undefined,
    pinnedAt: t.pinnedAt || undefined,
    pinOrderKey: t.pinOrderKey || undefined,
    backgroundLiveness: t.backgroundLiveness,
    // Omit an empty fingerprint (undefined) rather than sending ''. A tab with
    // no persisted tail (freshly created, no messages) has no fingerprint to
    // compare; '' would never match iOS's local tail and force a needless
    // reload. iOS treats absent as "nothing to compare". A real non-empty
    // fingerprint always passes through. (RC-4)
    convFingerprint: t.convFingerprint || undefined,
    pillColor: t.pillColor || null,
    pillIcon: t.pillIcon || null,
    totalCostUsd: t.runCostUsd,
    runCostUsd: t.runCostUsd,
    conversationCostUsd: t.conversationCostUsd,
    conversationTurns: t.conversationTurns,
    lastRunDurationMs: t.lastRunDurationMs,
    lastRunReason: t.lastRunReason,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
  }
}
