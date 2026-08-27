// ─── Engine status snapshots ───
//
// The two shapes the engine uses to answer "what is this session doing right
// now": `StatusFields` (the `engine_status` payload) and `SessionStatus` (the
// `engine_session_status` payload that is its designated successor). Both are
// COMPLETE snapshots — a consumer replaces its local view with the payload
// rather than merging fields into it.
//
// Extracted from types-engine.ts to keep that file under the 600-line cap.
// These two travel together: the successor mirrors the legacy shape field for
// field during the transition window, so a change to one is almost always a
// change to both, and keeping them adjacent is what makes the drift visible.

import type { BackgroundTaskState } from './types-engine'

export interface PollState {
  pollId: string
  intent: string
  attempt: number
  deadlineAt: number
  activeDispatchId?: string
  latestEvidence?: string
}

export interface StatusFields {
  label: string
  state: string
  sessionId?: string
  team?: string
  model: string
  /** Context-window occupancy as a percentage. UNBOUNDED — values above 100
   *  mean the conversation holds more tokens than the window it is measured
   *  against (the normal case when a conversation accumulated under a
   *  large-window model and the operator then selects a smaller one).
   *  Renderers clamp at their own display layer; the engine reports truth. */
  contextPercent: number
  /** Context window in tokens of the model the ENGINE actually used, i.e. the
   *  denominator `contextPercent` was computed against. Not the display
   *  denominator: a client whose model picker disagrees with the engine
   *  recomputes from `contextTokens` and the selected model's window. */
  contextWindow: number
  /** Absolute context-window occupancy in tokens — the numerator behind
   *  `contextPercent`, cache-aware (input + cache_read + cache_creation).
   *  This is the field clients divide by the SELECTED model's window: there
   *  is no engine command to change an idle session's model, so the
   *  picker-driven recompute is necessarily client-side arithmetic. */
  contextTokens?: number
  /** Usable input capacity after the engine reserves output and
   *  compaction-summary tokens. Mirrors the Go field of the same name; the
   *  engine keeps its 80%-occupancy warning internal, so clients derive any
   *  warning state from this limit rather than reading a flag. */
  contextEffectiveLimit?: number
  /** Cost of the most recent run in USD (cache-aware, descendants included).
   *  Replaces the former totalCostUsd field; the rename makes the scope
   *  unambiguous — "run" not "conversation". */
  runCostUsd?: number
  /** Why task completion occurred. Absent for older emitters and non-completion idle status. */
  completionReason?: import('./types-events').TaskCompletionReason | (string & {})
  /** Cumulative cost of the entire conversation (this session + all descendant
   *  dispatches) in USD. Computed via the cost.ConversationCost dispatch-tree
   *  walk on every TaskComplete. */
  conversationCostUsd?: number
  permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  /** Friendly display name broadcast by the extension (e.g. "Chief of Staff"). */
  extensionName?: string
  /** Number of background dispatch agents still running when the parent LLM
   *  turn ends. When > 0, the engine is "idle" but background work is in
   *  progress. Clients use this to keep the tab status active and the
   *  interrupt button visible. */
  backgroundAgents?: number
  /** Number of background bash commands (Bash run_in_background +
   *  notify_on_complete) the session is still waiting on. The shell
   *  counterpart to `backgroundAgents`: when > 0 the orchestrator may be idle
   *  while real work is in flight, and the engine holds the session open until
   *  the commands finish. Commands started WITHOUT notify_on_complete are not
   *  counted — nothing is waiting on them. */
  backgroundShells?: number
  /** Complete snapshot of every live session-owned background Bash process. */
  activeBackgroundTasks?: BackgroundTaskState[]
  /** Complete snapshot of every active inference-driven Poll. */
  activePolls?: PollState[]
  /** Number of Polls holding the session open. */
  pollsWaiting?: number
  /** True when the engine has accepted work that still prevents a terminal
   * completion. This includes dispatches, notifying shells, queued prompts,
   * durable completion deliveries, and parked runs. */
  hasPendingWork?: boolean
  /** Runs this session has accepted for dispatch, as of the instant this
   *  snapshot was built. Starts at zero, rises by one per accepted prompt,
   *  and never falls within one live session.
   *
   *  It exists so a consumer can order a snapshot against its own prompt.
   *  Several asynchronous engine sites build status snapshots (heartbeat,
   *  reconcile handshake, query_session_status), so one can be built after a
   *  client sent a prompt but before the engine assigned run identity to it.
   *  That snapshot honestly reports `state: 'idle'` — and without this field
   *  it is indistinguishable from the idle that ENDS the run, which is how a
   *  conversation gets marked done seconds before it starts working.
   *
   *  Record the epoch, send, then treat any snapshot whose epoch has not
   *  advanced past the recorded value as describing the state BEFORE the
   *  prompt. Absent means zero (a never-dispatched session, or an engine
   *  binary that predates the field).
   *
   *  Scope is one live session: a restarted or resumed session begins again
   *  at zero, so the value can DECREASE across a session boundary. A decrease
   *  means "new session, rebase" — never "stale snapshot". */
  runEpoch?: number
  /** Number of LLM turns completed in the most recent run. Stamped from
   *  TaskCompleteEvent.NumTurns; absent on idle and heartbeat status events. */
  numTurns?: number
  /** Conversation-lifetime prompt count: the number of real user prompts
   *  across the whole conversation, not just the most recent run. Stamped from
   *  TaskCompleteEvent.ConversationTurns; absent on idle and heartbeat status
   *  events. The drawer "Turns" row renders this (lifetime), whereas numTurns
   *  is the per-run round-trip count. */
  conversationTurns?: number
}

/**
 * Mirror of Go's `types.SessionStatus`. Phase 3 of the state-management
 * overhaul carries the engine's authoritative per-session status in one
 * typed payload that consumers can map onto their local cache without
 * inferring state from heterogeneous events (text deltas, message-end,
 * task-complete). See engine/internal/types/types.go for per-field
 * semantics; the wire shape is identical.
 *
 * Emitted by the engine alongside the legacy `engine_status` during the
 * transition window. Both events carry the same authoritative state;
 * Phase 4 removes the legacy emission once every in-repo consumer has
 * migrated to read this type.
 */
export interface SessionStatus {
  key: string
  state: string
  /** Unix-ms timestamp when the engine entered the current state.
   *  Zero means "not tracked yet"; populated once Phase 5 lands the
   *  per-session state-machine. */
  stateSince?: number
  /** Unix-ms timestamp when the engine last emitted a session-status
   *  event for this key. Always populated on inbound events. */
  lastEmittedAt: number
  /** True iff the backend has a live run for this key. The engine
   *  cross-checks `requestID` against the backend's run set so this
   *  flag cannot drift the way `tab.status === 'running'` did. */
  hasInflightRun?: boolean
  /** Number of background dispatch agents still running. Same
   *  semantics as `StatusFields.backgroundAgents`. */
  backgroundAgentCount?: number
  /** Number of background bash commands the session is still waiting on.
   *  Same semantics as `StatusFields.backgroundShells` — the shell
   *  counterpart to `backgroundAgentCount`, so a consumer reading only this
   *  event can tell a parked session (idle orchestrator, commands in flight)
   *  from a plain idle one. */
  backgroundShellCount?: number
  /** Complete snapshot of every live session-owned background Bash process. */
  activeBackgroundTasks?: BackgroundTaskState[]
  /** Exact engine verdict that accepted work remains pending even when the
   * foreground orchestrator has reached idle. */
  hasPendingWork?: boolean
  /** Runs accepted for dispatch as of this snapshot. Mirrors
   *  `StatusFields.runEpoch` — see that field for the ordering contract a
   *  consumer uses to tell a pre-dispatch idle from a run-ending idle. */
  runEpoch?: number
  /** Unresolved AskUserQuestion / ExitPlanMode entries retained
   *  across status emissions. Same shape as
   *  `StatusFields.permissionDenials`. */
  permissionDenialsPending?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  model?: string
  /** UNBOUNDED — see StatusFields.contextPercent. */
  contextPercent?: number
  contextWindow?: number
  /** Absolute context-window occupancy in tokens. Mirrors
   *  StatusFields.contextTokens. */
  contextTokens?: number
  /** Usable input capacity after engine output and summary reserves.
   *  Mirrors StatusFields.contextEffectiveLimit. */
  contextEffectiveLimit?: number
  /** Cost of the most recent run in USD. Matches StatusFields.runCostUsd semantics. */
  runCostUsd?: number
  /** Cumulative cost of the entire conversation (this session + all descendant dispatches) in USD. */
  conversationCostUsd?: number
  sessionId?: string
  extensionName?: string
}