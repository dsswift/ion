/**
 * Remote tab state types — extracted from protocol.ts for line-cap.
 *
 * Contains the wire shapes that describe per-tab state sent in the
 * desktop_snapshot and individual tab events. Consumed by snapshot.ts,
 * command-handler.ts, iOS NormalizedEvent+Lifecycle.swift, and tests.
 *
 * Re-exported from protocol.ts; all existing import paths continue to work.
 */

import type { TabStatus, PermissionRequest, ElicitationRequest } from '../../shared/types'
import type { DispatchTelemetryEntry } from '../../shared/types-engine'

// ─── Remote Tab State (lightweight projection for mobile clients) ───

export interface RemoteTabState {
  id: string
  title: string
  customTitle: string | null
  status: TabStatus
  workingDirectory: string
  permissionMode: 'auto' | 'plan'
  /**
   * Per-conversation extended-thinking effort (bare conversation / active
   * instance). 'low' | 'medium' | 'high' when set; omitted when off. iOS
   * renders the per-conversation thinking control from this. Mirrors
   * TabState.thinkingEffort / ConversationInstance.thinkingEffort.
   */
  thinkingEffort?: 'low' | 'medium' | 'high'
  permissionQueue: PermissionRequest[]
  /**
   * Live extension elicitations (ctx.elicit) awaiting a user decision on the
   * active instance. Mirrors ConversationInstance.elicitationQueue. iOS renders
   * an approval card from the head entry and answers via
   * `desktop_respond_elicitation`. Optional/additive — older snapshots omit it.
   */
  elicitationQueue?: ElicitationRequest[]
  lastMessage: string | null
  contextTokens: number | null
  /**
   * Engine-reported context window size (tokens) of the model the engine
   * actually used on the most recent turn. Mirrors TabState.contextWindow.
   * iOS reads this as the denominator when recomputing context percent
   * locally so the indicator stays accurate even when the picker-selected
   * model disagrees with the engine. Falls back to the picker model's
   * nominal window when null (cold-start tabs).
   */
  contextWindow: number | null
  /**
   * Cost of the most recent run in USD (cache-aware, descendants included).
   * Projected from StatusFields.runCostUsd via the snapshot so iOS has the
   * correct value on cold open without waiting for a live engine_status event.
   * Optional so tabs that have never had a run omit it rather than emitting 0.
   */
  runCostUsd?: number
  /**
   * Cumulative cost of the entire conversation (this session + all descendant
   * dispatches) in USD. Optional — absent on tabs that have never run.
   */
  conversationCostUsd?: number
  /**
   * Conversation-lifetime prompt count: the number of real user prompts across
   * the whole conversation (engine's conversation.CountUserPrompts), NOT the
   * per-run round-trip count. Projected from lastResult.conversationTurns via
   * the snapshot so iOS renders the drawer "Turns" row (lifetime) on cold open
   * without waiting for a live engine_status event. Optional — absent on tabs
   * that have never had a run report it.
   */
  conversationTurns?: number
  /**
   * @deprecated Use runCostUsd. Kept for lockstep iOS wire compatibility
   * until the iOS side migrates to runCostUsd. Both fields are projected in
   * the same snapshot; iOS should prefer runCostUsd once updated.
   */
  totalCostUsd?: number
  /**
   * Cumulative provider-reported input tokens for this tab. Projected from
   * the engine's usage tracking so iOS can populate the context-breakdown
   * section on cold open. Optional — absent on tabs that have never run.
   */
  inputTokens?: number
  /** Cumulative output tokens. Optional — absent on never-run tabs. */
  outputTokens?: number
  /**
   * Cumulative cache-read tokens (Anthropic prompt caching). Optional —
   * absent on tabs that have never run or whose provider does not report it.
   */
  cacheReadTokens?: number
  /**
   * Cumulative cache-creation tokens (Anthropic prompt caching). Optional —
   * absent on tabs that have never run or whose provider does not report it.
   */
  cacheCreationTokens?: number
  modelOverride?: string | null
  messageCount: number
  /**
   * Conversation tail fingerprint — the staleness signal for the iOS
   * main-conversation heal. Computed over the active instance's last N messages
   * (id + utf8 content length for non-tool rows; tool status for tool rows) +
   * total message count. iOS computes the SAME fingerprint over its local tail
   * and re-fetches history when they diverge (dropped live deltas, e.g. a
   * LAN↔relay transport switch). Algorithm pinned in
   * ../../shared/conversation-fingerprint.ts (and mirrored byte-identically in
   * the snapshot.ts inline JS and the Swift conversationTailFingerprint).
   * Empty string for cold-start tabs (no live messages to compare).
   */
  convFingerprint?: string
  queuedPrompts: string[]
  isTerminalOnly?: boolean
  /** True when the conversation hosts an engine extension. Wire field consumed
   *  by iOS (RemoteTabState.swift). Not a backend flag. */
  hasEngineExtension?: boolean
  engineProfileId?: string | null
  conversationInstances?: Array<{
    id: string
    label: string
    waitingState?: 'plan-ready' | 'question' | null
    isRunning?: boolean
    runningAgentCount?: number
    modelFallback?: { requestedModel: string; fallbackModel: string }
    conversationIds?: string[]
    thinkingEffort?: 'low' | 'medium' | 'high'
    dispatchTelemetry?: DispatchTelemetryEntry[]
  }>
  activeConversationInstanceId?: string | null
  terminalInstances?: TerminalInstanceInfo[]
  activeTerminalInstanceId?: string | null
  groupId?: string | null
  /** When true, auto-group movement is suppressed for this tab. */
  groupPinned?: boolean
  /**
   * Aggregated "any sub-instance has running background children" flag,
   * folded across `conversationInstances[*].runningAgentCount`. Optional so
   * older iOS builds that don't decode the field continue to work; iOS
   * uses this to drive the parent tab pill's yellow "awaiting children"
   * dot. See CLAUDE.md § "Common parity surfaces" for the desktop/iOS
   * parity rule.
   */
  hasRunningChildren?: boolean
  /** The current conversation/session ID for this tab. Engine tabs use StatusFields.sessionId instead. */
  conversationId?: string | null
  /** Unix ms timestamp of the last status-changing activity (message, status change). */
  lastActivityAt?: number
  /** Custom pill background color hex string (e.g. "#f08c4a"). Null means use theme default. */
  pillColor?: string | null
  /** Custom pill icon key (e.g. "diamond", "star"). Null means use the default status dot. */
  pillIcon?: string | null
}

// ─── Terminal instance metadata ───

export interface TerminalInstanceInfo {
  id: string
  label: string
  kind: string    // 'user' | 'commit' | 'cli' | 'tool:*'
  readOnly: boolean
  cwd: string
}

// ─── Wire-friendly message types for conversation sync ───

export interface RemoteMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  toolInput?: string
  toolId?: string
  toolStatus?: 'running' | 'completed' | 'error'
  attachments?: RemoteAttachment[]
  timestamp: number
  source?: 'desktop' | 'remote'
  /** Slash-command provenance: when the turn came from a slash command, the echo carries command/args so iOS renders a pill immediately. */
  slashCommand?: string
  slashArgs?: string
  slashSource?: string
  /** Plan path on plan-lifecycle divider system messages (Plan created / Plan
   * updated / Implementing plan). Lets iOS render the divider's slug as a
   * clickable link to the plan preview after a history reload. Omitted on
   * non-divider messages. */
  planFilePath?: string
}

export interface RemoteAttachment {
  id: string
  type: 'image' | 'file' | 'plan'
  name: string
  path: string
}
