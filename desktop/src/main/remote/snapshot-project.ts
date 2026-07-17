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
  permissionMode?: string
  thinkingEffort?: string | null
  contextTokens?: number | null
  contextWindow?: number | null
  messageCount?: number
  queuedPrompts?: string[]
  isTerminalOnly?: boolean
  hasEngineExtension?: boolean
  /** Engine profile id — non-null for extension-hosted tabs. iOS uses this
   *  to resolve the harness badge display name from desktop_engine_profiles.
   *  Without this field, iOS falls back to the literal "EXT" badge label. */
  engineProfileId?: string | null
  conversationInstances?: RemoteTabState['conversationInstances']
  activeConversationInstanceId?: string | null
  terminalInstances?: RemoteTabState['terminalInstances']
  activeTerminalInstanceId?: string | null
  groupId?: string | null
  modelOverride?: string | null
  groupPinned?: boolean
  hasRunningChildren?: boolean
  conversationId?: string | null
  lastActivityTs?: number
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
    permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
    thinkingEffort: (t.thinkingEffort && t.thinkingEffort !== 'off')
      ? t.thinkingEffort as 'low' | 'medium' | 'high'
      : undefined,
    permissionQueue: opts.permissionQueue,
    elicitationQueue: opts.elicitationQueue ?? [],
    lastMessage: opts.lastMessage,
    contextTokens: t.contextTokens || null,
    contextWindow: t.contextWindow ?? null,
    messageCount: t.messageCount || 0,
    queuedPrompts: t.queuedPrompts || [],
    isTerminalOnly: t.isTerminalOnly || undefined,
    hasEngineExtension: t.hasEngineExtension || undefined,
    // iOS resolves the harness badge display name by matching
    // engineProfileId against the desktop_engine_profiles list.
    // Without this field, the badge falls back to literal "EXT".
    engineProfileId: t.engineProfileId || null,
    conversationInstances: t.conversationInstances || undefined,
    activeConversationInstanceId: t.activeConversationInstanceId || undefined,
    terminalInstances: t.terminalInstances || undefined,
    activeTerminalInstanceId: t.activeTerminalInstanceId || undefined,
    groupId: t.groupId || null,
    modelOverride: t.modelOverride || null,
    groupPinned: t.groupPinned || false,
    hasRunningChildren: t.hasRunningChildren || undefined,
    conversationId: t.conversationId || undefined,
    lastActivityAt: t.lastActivityTs || undefined,
    convFingerprint: t.convFingerprint || '',
    pillColor: t.pillColor || null,
    pillIcon: t.pillIcon || null,
    totalCostUsd: t.runCostUsd,
    runCostUsd: t.runCostUsd,
    conversationCostUsd: t.conversationCostUsd,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
  }
}
