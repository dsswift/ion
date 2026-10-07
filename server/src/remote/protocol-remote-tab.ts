/**
 * Remote tab state types — extracted from protocol.ts for line-cap.
 *
 * Contains the wire shapes that describe per-tab state sent in the
 * desktop_snapshot and individual tab events. Consumed by snapshot.ts,
 * command-handler.ts, iOS NormalizedEvent+Lifecycle.swift, and tests.
 *
 * Re-exported from protocol.ts; all existing import paths continue to work.
 */

import type { TabStatus, PermissionRequest, ElicitationRequest } from '@ion/shared/types'
import type { DispatchTelemetryEntry } from '@ion/shared/types-engine'
import type { ComposerAction } from '@ion/shared/studio-sdk-contract'

// ─── Remote Tab State (lightweight projection for mobile clients) ───

export interface RemoteTabState {
  id: string
  title: string
  customTitle: string | null
  status: TabStatus
  workingDirectory: string
  /** Execution host that owns this desktop snapshot. */
  executionHost?: string
  /** Stable hardware identity for the execution host, when available. */
  executionMachineId?: string
  permissionMode: 'auto' | 'plan'
  /**
   * The last plan-mode change a before_plan_mode_* handler vetoed on the
   * active conversation, so a client can say why its toggle reverted.
   * Omitted when nothing was refused or a later change succeeded.
   */
  planModeRejection?: import('@ion/shared/types-engine').PlanModeRejection
  /**
   * Per-conversation extended-thinking effort (bare conversation / active
   * instance). 'adaptive' | 'low' | 'medium' | 'high' when set; omitted when
   * off. 'adaptive' means the model self-regulates depth. iOS
   * renders the per-conversation thinking control from this. Mirrors
   * TabState.thinkingEffort / ConversationInstance.thinkingEffort.
   */
  thinkingEffort?: 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  permissionQueue: PermissionRequest[]
  /**
   * The Composer Actions this conversation offers, as the server decided them
   * (`server/src/engine/composer-actions.ts`). iOS lists them in the
   * composer's `+` menu. Omitted when the conversation offers none.
   */
  composerActions?: ComposerAction[]
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
  /** Latest completed run duration, in milliseconds. */
  lastRunDurationMs?: number
  /** Terminal reason for latest completed run. */
  lastRunReason?: import('@ion/shared/types-events').TaskCompletionReason | (string & {})
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
  /** The active instance's resolved model: what the conversation runs on, decided by its server. Empty or absent when nothing resolves and the engine applies its own default. */
  resolvedModel?: string
  messageCount: number
  queuedPrompts: string[]
  /**
   * The conversation's unsent composer text, as the owning server holds it.
   *
   * Durable state, not a live keystroke feed: a client adopts this when it
   * OPENS the conversation and never while its own composer is in use, so the
   * composer with the conversation open owns the text and the rest adopt on
   * open (see useComposerDraft.ts and SessionViewModel+Drafts.swift). Omitted
   * when the conversation has no draft.
   */
  draftInput?: string
  isTerminalOnly?: boolean
  /** Input-locked conversation (auto-generated conflict fix): clients must
   *  not offer a prompt input for this tab. See TabState.inputLocked. */
  inputLocked?: boolean
  /**
   * True while the engine is compacting this conversation (manual or
   * proactive). There is no way to steer a compaction in progress, so
   * clients must refuse a send rather than queue it — mirrors the desktop
   * InputBar's `!isCompacting` gate on `canSend`. See TabState.isCompacting.
   */
  isCompacting?: boolean
  /** Why the tab is locked. `landed-worktree` is a sealed review session and
   * `settled` is a cold Inbox history record. */
  inputLockReason?: 'automated-workflow' | 'landed-worktree' | 'settled'
  /** Explicit tab lifecycle role (see TabState.tabRole). Desktop-internal
   *  policy: iOS does not switch on it — it rides the snapshot so the main
   *  process can resolve the bench singleton and exclude auto-fix tabs from
   *  the openConversations projection. Absent = default (null). */
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis'
  /** True when the conversation hosts an engine extension. Wire field consumed
   *  by iOS (RemoteTabState.swift). Not a backend flag. */
  hasEngineExtension?: boolean
  engineProfileId?: string | null
  conversationInstances?: Array<{
    id: string
    label: string
    waitingState?: 'plan-ready' | 'question' | null
    isRunning?: boolean
    /** Engine session is attaching without a foreground run. */
    isStarting?: boolean
    runningAgentCount?: number
    /** Background bash commands this instance is waiting on (Bash
     *  run_in_background + notify_on_complete). The shell counterpart to
     *  runningAgentCount; drives the iOS pink shell dot. */
    backgroundShellCount?: number
    activeBackgroundTasks?: import('@ion/shared/types-engine').BackgroundTaskState[]
    activePolls?: import('@ion/shared/types-engine').PollState[]
    pollsWaiting?: number
    /** Exact engine status verdict for accepted work with no foreground run. */
    hasPendingWork?: boolean
    modelFallback?: { requestedModel: string; fallbackModel: string }
    /** The model this instance runs on, as the server resolved it (model-resolution.ts). Clients render it and never a default of their own. */
    resolvedModel?: string
    conversationIds?: string[]
    thinkingEffort?: 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    dispatchTelemetry?: DispatchTelemetryEntry[]
  }>
  activeConversationInstanceId?: string | null
  terminalInstances?: TerminalInstanceInfo[]
  activeTerminalInstanceId?: string | null
  hasRunningTerminal?: boolean
  terminalApplications?: import('@ion/shared/terminal-activity').TerminalWebApplication[]
  /**
   * Aggregated "any sub-instance has running background children" flag,
   * folded across `conversationInstances[*].runningAgentCount`. Optional so
   * older iOS builds that don't decode the field continue to work; iOS
   * uses this to drive the parent tab pill's yellow "awaiting children"
   * dot. See docs/architecture/cross-platform-parity.md § "Common parity surfaces" for the desktop/iOS
   * parity rule.
   */
  hasRunningChildren?: boolean
  /**
   * Total background bash commands this tab is waiting on, summed across
   * `conversationInstances[*].backgroundShellCount`. Optional so older iOS
   * builds that don't decode the field continue to work; iOS uses it to drive
   * the parent tab pill's pink shell dot and the "waiting on N background
   * shells" indicator. Summed rather than max'd: separate instances run
   * separate processes.
   */
  backgroundShellCount?: number
  /** Engine-owned verdict that this tab still has accepted asynchronous or
   * queued work, even when no foreground run is active. */
  hasPendingWork?: boolean
  /** The current conversation/session ID for this tab. Engine tabs use StatusFields.sessionId instead. */
  conversationId?: string | null
  /** Complete canonical engine session chain, oldest to newest. */
  sessionIds?: string[]
  /**
   * Unix ms timestamp of the last GENUINE activity (user message, turn
   * start, completion — never reconnect/heartbeat). The snapshot sort key.
   * Semantics FIXED to the honest value in the inbox change: iOS never
   * sorts, so Classic reorders once when this became honest (intentional,
   * stated in the PR).
   */
  lastActivityAt?: number
  /**
   * Unix ms of the newest real user or assistant message — the last turn that
   * actually went to the provider, and therefore the last turn that wrote the
   * conversation's prompt cache. Distinct from `lastActivityAt`, which a
   * reconnect or a status re-emission also stamps; a client pricing a model
   * switch needs the honest turn boundary, because a cache's age decides
   * whether its cheap read rate still applies.
   */
  lastMessageAt?: number
  /** Unix ms of the last running→idle transition (renderer-observed). */
  idleSince?: number
  /** Immutable creation timestamp — the "Newest created" inbox sort key. */
  createdAt?: number
  /**
   * Explicit worktree identity when the tab lives in a managed worktree.
   * Clients group by THIS (repoPath / worktreePath), never by path-prefix
   * guessing against the worktree inventory — a freshly created worktree the
   * inventory has not crawled yet still groups under its source repository.
   */
  worktree?: {
    worktreePath: string
    branchName: string
    sourceBranch: string
    repoPath: string
    landedAt?: number
  }
  /** Desktop-derived inbox classification. iOS renders, never re-derives. */
  inboxState?: 'active' | 'snoozed' | 'settled'
  /** Inbox unread (manual marker || completion newer than last visit). */
  /** Desktop-derived review state. Always present in current snapshots. */
  unread?: boolean
  /** Snooze wake time (ms) while snoozed. */
  snoozedUntil?: number
  /** When the conversation was settled (settled-shelf ordering). */
  settledAt?: number
  /** Why the hard settled state was entered. Only 'auto' changes the row marker. */
  settledOverride?: 'settled' | 'active' | 'auto'
  /** True when a cold settled record can be opened and resumed. False when its worktree was retired. */
  canRestoreSettled?: boolean
  /** Wake moment for the Woke pill (expired snooze not yet visited). */
  wokeAt?: number
  /** Unix ms the usage limit holding this conversation resets. Absent when none holds. */
  limitedUntil?: number
  /** The window that ran out ("five_hour", "seven_day"), while one holds. */
  limitType?: string
  /** How the prompt the server holds for this conversation is released, when it holds one. */
  deferredRelease?: 'limit-reset' | 'spare-quota'
  /** The row asks nothing of the person now; a client draws it receded. */
  quiet?: boolean
  /** Inbox pin timestamp and fractional presentation order. */
  pinnedAt?: number
  pinOrderKey?: string
  /** Desktop-derived background state: agent work outranks monitor-only shells. */
  backgroundLiveness?: 'working' | 'monitoring'
  /** Custom pill background color hex string (e.g. "#f08c4a"). Null means use theme default. */
  pillColor?: string | null
  /** Custom pill icon key (e.g. "diamond", "star"). Null means use the default status dot. */
  /**
   * Main-owned guided-questions workflows open on this tab (the
   * QuestionsCoordinator's per-session projection). Merged AFTER renderer
   * projection and in the cold-start path — canonical wizard state never
   * round-trips through the renderer. iOS first paint and seq-gap recovery
   * read this; live updates ride desktop_questions_state.
   */
  questions?: import('@ion/shared/questions-state').QuestionsWorkflowState[]
  /**
   * Which server environment produced this snapshot (manifest C3's
   * `studio_welcome.environmentId`, minted by `identity/environment-id.ts`).
   * Stamped onto every tab by `getRemoteTabStates` (child 09) so a phone
   * paired with more than one server can label a tab's origin. Absent only
   * before the server has minted an id (impossible past boot).
   */
  environmentId?: string
  /** Human-readable label for `environmentId` (server.json's `label`, default hostname). */
  environmentLabel?: string
}

// ─── Terminal instance metadata ───

export interface TerminalInstanceInfo {
  id: string
  label: string
  kind: string    // 'user' | 'commit' | 'cli' | 'tool:*'
  readOnly: boolean
  cwd: string
  isRunning?: boolean
  processLabel?: string
  applications?: import('@ion/shared/terminal-activity').TerminalWebApplication[]
}
