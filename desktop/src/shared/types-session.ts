// @file-size-exception: types-session.ts is a shared type barrel; enterprise
// policy types were added in #256. Next split: extract enterprise types into
// types-enterprise.ts when the file grows by another ~80 lines.
import type { UsageData } from "./types-events";

// ─── Thinking ───

/**
 * Per-conversation extended-thinking effort.
 *
 *   'adaptive'            — request thinking but let the model choose its own
 *                           depth per turn. The default for models whose
 *                           `thinkingMode` is `adaptive` (Anthropic). The
 *                           engine sends the thinking directive with NO effort,
 *                           so the model self-regulates.
 *   'low' | 'medium' | 'high' — pin the depth. On an adaptive model this
 *                           overrides the model's own judgment on every turn,
 *                           which is a deliberate choice, not a default.
 *   'off'                 — no thinking directive at all.
 *
 * Which values a model actually offers is driven by its capability metadata:
 * adaptive models show `Adaptive` in place of `Off` (they reason regardless,
 * so "off" would be a lie), effort-based models show `Off`. See
 * `thinkingOptionsForMode` in `shared/thinking-options.ts`.
 *
 * Stored per-instance, applied live on the next prompt.
 */
export type ThinkingEffort =
  "off" | "adaptive" | "low" | "medium" | "high" | "xhigh" | "max";

// ─── Tab Grouping ───

export const DEFAULT_TAB_GROUP_LABELS = [
  "Planning",
  "On Deck",
  "In Progress",
  "Testing",
] as const;

export type TabGroupMode = "off" | "auto" | "manual";

export interface TabGroup {
  id: string; // nanoid
  label: string; // user-provided name (manual) or dir name (auto)
  isDefault: boolean; // manual mode: where new tabs land
  order: number; // position in strip
  collapsed: boolean; // whether the group shows as a single pill
}

// ─── Tab State Machine (v2 — from execution plan) ───

export type TabStatus =
  | "connecting"
  | "starting"
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "dead";

export interface PermissionRequest {
  questionId: string;
  toolTitle: string;
  toolDescription?: string;
  toolInput?: Record<string, unknown>;
  options: Array<{ optionId: string; kind?: string; label: string }>;
  /** Engine instance (sub-tab) this request belongs to. Set for engine-view
   * denials promoted into the tab-level queue so clients can scope the
   * card to the owning sub-conversation. Absent for CLI tabs and for
   * requests that predate this field (additive, non-breaking). */
  instanceId?: string;
}

/**
 * A live extension elicitation awaiting a user decision for a conversation.
 * Produced when an extension calls `ctx.elicit()`; the engine fans an
 * `engine_elicitation_request` event to every client. The client renders a
 * card from `mode` + `schema` and answers with an `elicitation_response`
 * command carrying the `requestId`. Distinct from `PermissionRequest`
 * (tool-call permission) and from `permissionDenied` (the plan-ready /
 * AskUserQuestion fallback card).
 */
export interface ElicitationRequest {
  /** Engine-assigned id echoed back in the elicitation_response command. */
  requestId: string;
  /** Renderer selector ("approval", "select", ...). May be empty. */
  mode: string;
  /** Harness-defined description of what is being requested. */
  schema?: Record<string, unknown>;
  /** Optional deep-link URL for web flows. */
  url?: string;
  /** Extension or subsystem that raised the elicitation. */
  source?: string;
  /** MCP/tool server name, when the elicitation originates from one. */
  server?: string;
  /** Human-readable description of what the elicitation is asking. */
  message?: string;
  /** Label for the primary approval action (e.g. "Install", "Connect"). */
  action?: string;
}

export interface FileAttachment {
  id: string;
  type: "image" | "file";
  name: string;
  path: string;
  mimeType?: string;
  /** Exact SHA-256 identity of decoded image bytes. Absent on legacy rows. */
  contentHash?: string;
  /** Base64 data URL for image previews */
  dataUrl?: string;
  /** File size in bytes */
  size?: number;
}

export interface PlanAttachment {
  id: string;
  type: "plan";
  name: string;
  path: string;
}

export type Attachment = FileAttachment | PlanAttachment;

export interface TabState {
  id: string;
  conversationId: string | null;
  historicalSessionIds: string[];
  /** Most recent non-null conversationId; never cleared. Recovery fallback when conversationId is null. */
  lastKnownSessionId: string | null;
  /**
   * Transient: the conversationId a deliberate checkpoint cut (clear-context)
   * just left behind, to be recorded as the next session's on-disk `parentId`.
   * Set when clear-context nulls conversationId; consumed once by the next
   * engine start (passed as EngineConfig.parentConversationId), then cleared.
   * Never persisted — it only bridges the cut to the subsequent start.
   */
  pendingParentConversationId?: string | null;
  status: TabStatus;
  activeRequestId: string | null;
  /**
   * Wall-clock ms of last engine-originated event for this tab. Drives the
   * stuck-tab watchdog and the "any event counts" freshness pill. Persisted
   * (1s coalescer in store-identity.ts) and restored.
   *
   * NOT an activity signal: reconnects, heartbeats, and status re-emissions
   * all stamp it. Honest activity is `lastActivityAt` below.
   */
  lastEventAt: number | null;
  /**
   * Wall-clock ms of the last non-message renderer activity. This remains
   * useful for diagnostics, but is NEVER an inbox sort, age, or settle signal.
   */
  lastActivityAt: number | null;
  /** True while a machine-authored injected run streams. Never persisted. */
  inboxMessageSuppressed?: boolean;
  /**
   * Wall-clock ms of the newest real user or assistant message. This is the
   * inbox source of truth. Background delivery, schedules, webhooks, status
   * events, and task completion do not write it.
   */
  lastMessageAt?: number | null;
  /**
   * Wall-clock ms of the last running→idle transition (renderer-observed).
   * Persisted verbatim; after restore only a live running→idle transition
   * overwrites it — never re-stamped at boot (D9).
   *
   * Engine SessionStatus.stateSince records the authoritative state transition
   * time. This renderer field records its observed tab transition because tab
   * state can also change through local recovery and event reduction.
   */
  idleSince: number | null;
  /** Immutable creation timestamp for stable inbox and pinned fallback order. */
  createdAt?: number;
  /** Wall-clock ms of the newest failure; compares against snoozedAt for wake. */
  lastFailureAt?: number | null;
  /** Inbox pin timestamp. Pinned rows keep a full-card position above active rows. */
  pinnedAt?: number | null;
  /** Fractional base-26 ordering key for pinned rows. */
  pinOrderKey?: string | null;
  /** Wall-clock ms of the last task_complete (inbox unread derivation). */
  lastCompletionAt: number | null;
  /**
   * Inbox settle provenance: 'settled' = operator, 'auto' = idle clock,
   * 'active' = explicit keep-active, null = not settled. Both settled values
   * are hard, input-locked states; only their provenance differs.
   */
  settledOverride: "settled" | "active" | "auto" | null;
  /** When the tab was settled (settled-shelf sort key). */
  settledAt: number | null;
  /** Snooze wake time (ms). Snoozed tabs sit on the snoozed shelf until
   *  wake or a raised hand (pending ask / fresh error / completion). */
  snoozedUntil: number | null;
  /** When the snooze was set (raised-hand comparisons). */
  snoozedAt: number | null;
  /** Last time the user visited (selected) this tab. Inbox unread =
   *  manualUnread || max(lastCompletionAt, lastMessageAt) > lastVisitedAt;
   *  never-visited = read. */
  lastVisitedAt: number | null;
  /** User-forced unread marker (cleared on visit). */
  manualUnread: boolean;
  /**
   * Auto-recovery bookkeeping for the stuck-tab watchdog. When a running tab
   * goes silent past the recovery threshold, the watchdog automatically
   * recreates the engine session and resubmits the last prompt (in-process, no
   * engine restart). These two fields bound that automatic resume so a truly
   * dead provider cannot drive an infinite stall→resume loop: attempts are
   * counted within a rolling window, and once the cap is hit the watchdog stops
   * auto-resuming and surfaces an honest, actionable message instead. Not
   * persisted — recovery is a live-session concern that resets on restart.
   */
  autoRecoveryAttempts?: number;
  autoRecoveryWindowStartedAt?: number | null;
  currentActivity: string;
  attachments: FileAttachment[];
  /**
   * One-shot field: set by rewind, consumed by InputBar to pre-fill input,
   * then cleared. Tab-level because rewind targets the tab's active
   * conversation and the InputBar is tab-scoped.
   */
  pendingInput?: string;
  title: string;
  /** User-provided custom tab name (overrides auto-generated title when set) */
  customTitle: string | null;
  /** Last run's result data (cost, tokens, duration) */
  lastResult: RunResult | null;
  sessionTools: string[];
  sessionMcpServers: Array<{ name: string; status: string }>;
  sessionSkills: string[];
  sessionVersion: string | null;
  /** Prompts waiting behind the current run (display text only) */
  queuedPrompts: string[];
  /** Working directory for this tab's sessions */
  workingDirectory: string;
  /** Whether the user explicitly chose a directory (vs. using default home) */
  hasChosenDirectory: boolean;
  /** Extra directories accessible via --add-dir (session-preserving) */
  additionalDirs: string[];
  /** Pending bash command results to send as context with next prompt */
  bashResults: Array<{ command: string; stdout: string; stderr: string }>;
  /** Whether a bash command is currently executing in this tab */
  bashExecuting: boolean;
  /** ID of the currently executing bash command (for cancellation) */
  bashExecId: string | null;
  /** Custom pill outline color (null = use theme default) */
  pillColor: string | null;
  /** Custom pill icon shape (null = default circle dot) */
  pillIcon: string | null;
  /** Session ID this tab was forked from (null if not a fork) */
  forkedFromSessionId: string | null;
  /** Host where this conversation executes. Durable for future remote execution. */
  executionHost?: string | null;
  /** Stable execution-machine identity when the host exposes one. */
  executionMachineId?: string | null;
  /** Worktree metadata when tab operates inside a managed worktree */
  worktree: WorktreeInfo | null;
  /** True while waiting for the user to pick a source branch in the BranchPickerDialog */
  pendingWorktreeSetup: boolean;
  /** Tab group assignment (null = ungrouped / auto-computed) */
  groupId: string | null;
  /**
   * When true, suppresses autoGroupMovement for this tab.
   * Manual moves preserve the pin — the new group becomes the sticky anchor.
   * Toggle via right-click → "Pin to group" / "Unpin from group".
   */
  groupPinned: boolean;
  /**
   * Absolute context-window occupancy in tokens for the tab's active
   * conversation instance, mirrored from `statusFields.contextTokens`.
   *
   * The renderer's own indicator reads `statusFields` directly — this
   * tab-level copy exists because the desktop→iOS snapshot projects
   * per-tab scalars and does NOT project per-instance `statusFields`
   * (see remote-projection.ts). It is the wire carrier, not a second
   * source of truth: both are written from the same engine status event.
   */
  contextTokens: number | null;
  /**
   * Engine-reported context window size (tokens) for the model the engine
   * actually used on the most recent turn — the denominator the ENGINE
   * computed its percentage against. Mirrored from
   * `statusFields.contextWindow` for the same snapshot-projection reason
   * as `contextTokens`.
   *
   * This is NOT the display denominator. The status bar and drawer divide
   * `contextTokens` by the SELECTED model's window
   * (`getDynamicContextWindow`), because there is no engine command to
   * change an idle session's model: a picker-driven recompute is
   * necessarily client-side arithmetic.
   *
   * Null on a fresh tab (no engine response yet).
   */
  contextWindow: number | null;
  /** True while the engine is actively compacting context */
  isCompacting: boolean;
  /** Terminal-focused tab with no conversation */
  isTerminalOnly: boolean;
  /**
   * When true, the operator cannot type into this conversation. Set on the
   * auto-generated conflict-resolution conversations (the AI Assisted rebase /
   * merge fixes) and on the bench-verification analysis conversation: their
   * entire instruction is the one machine-sent prompt, and a follow-up message
   * would graft an open-ended conversation onto a tab whose working directory
   * — often an integration bench — is not where development work belongs. The
   * fix/analysis conversation stays readable and abortable; it just refuses
   * new prompts.
   */
  inputLocked: boolean;
  /** Why input is locked. `landed-worktree` seals review-only conversations,
   * `settled` seals a cold Inbox history record, and automated workflows admit
   * their one initial `source: 'machine'` prompt. */
  inputLockReason?: "automated-workflow" | "landed-worktree" | "settled" | null;
  /**
   * Explicit lifecycle role for tabs that share one directory. A bench can
   * simultaneously hold the persistent operator conversation, its dedicated
   * terminal, and several ephemeral machine-driven fix conversations — the
   * directory alone cannot distinguish them, so identity is stored, not
   * inferred from paths or titles.
   *
   * - `'bench-conversation'`: the ONE persistent operator conversation for a
   *   bench (the singleton slot). Focused, never duplicated, by every open
   *   entry point (desktop git panel, Studio, iOS).
   * - `'conflict-auto-fix'`: an ephemeral, input-locked machine conversation
   *   created by conflict assist. It closes only on a typed `normal` completion
   *   with no denied or pending operator input. Every other completion stays for
   *   diagnosis.
   * - `'verification-analysis'`: an input-locked machine analysis conversation.
   *   It stays open after completion so the operator can inspect its report.
   * - `null`/absent: every other tab (default). Terminal identity stays
   *   derived via `isTerminalOnly` + `pickDirTerminal`, not a role.
   */
  tabRole?:
    "bench-conversation" | "conflict-auto-fix" | "verification-analysis" | null;
  /**
   * Engine profile ID used for this tab (references EngineProfile.id).
   * Non-null/non-empty means the tab has extensions loaded (derived via
   * `tabHasExtensions()` from shared/tab-predicates.ts).
   */
  engineProfileId: string | null;
  /** Short single-line preview of the last visible message (~80 chars), used
   *  as a tab-pill subtitle to help distinguish multiple Jarvis sessions. */
  lastMessagePreview: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "harness" | "thinking";
  content: string;
  toolName?: string;
  toolInput?: string;
  toolId?: string;
  toolStatus?: "running" | "completed" | "error";
  /** True for messages originating from user bash command entry (! prefix) */
  userExecuted?: boolean;
  /** True when the expand-tool-results setting auto-expanded this result */
  autoExpandResult?: boolean;
  /** File or plan attachments associated with this message */
  attachments?: Attachment[];
  /**
   * Optional dedup key carried verbatim from
   * `engine_harness_message.metadata.dedupKey`. The renderer uses it to
   * suppress repeated emissions in the same engine-instance scrollback —
   * if a `role: 'harness'` message with this key already exists in the
   * key's message list, the new event is dropped instead of pushed.
   * Persists with the message so dedup survives app restart and rehydrate.
   * Other roles ignore this field; only harness messages opt in.
   * Convention: `<extensionName>:<messageKey>` (e.g. `my-extension:welcome`).
   * See engine-event-slice.ts for the consumer logic and
   * docs/protocol/server-events.md for the well-known-keys table.
   */
  dedupKey?: string;
  /**
   * Path to the plan file associated with a plan-created divider message.
   * Populated only on `role: 'system'` messages whose content starts with
   * `── Plan created`. The renderer uses it to make the plan slug clickable
   * (opens the plan preview, same as clicking a plan in the attachment drawer).
   * Client-only field — NOT part of the Go contract or wire protocol.
   */
  planFilePath?: string;
  /**
   * Engine-provided slash-command metadata for rendering a command PILL.
   * Populated from `SessionMessage.slashCommand` (and siblings) returned by
   * `load_session_history` when the displayed user turn was a slash
   * invocation. When `slashCommand` is non-empty, `content` already holds
   * the RAW invocation (the engine stored the raw invocation as the display
   * turn; the expanded body lives only in the LLM history). The renderer
   * renders the pill from these fields rather than re-parsing `content`.
   * Client-render fields — round-trip the engine's values; persisted
   * alongside the message (see serialize-conversation-pane.ts and
   * types-persistence.ts) so the pill survives app restart.
   */
  slashCommand?: string;
  /** Slash args (the text after `/name`), from `SessionMessage.slashArgs`. */
  slashArgs?: string;
  /** Origin of the resolved template: "extension"|"ion"|"claude"|"skill"|"project". */
  slashSource?: string;
  /** Command-owned model selector from slash frontmatter, such as `fast`. */
  slashModelAlias?: string;
  /** Concrete model the engine selected for this slash invocation after tier and provider resolution. */
  slashModelEffective?: string;
  /** Complete parsed command frontmatter, including extension-defined keys. */
  slashFrontmatter?: Record<string, unknown>;
  /** True when this user turn starts an approved plan implementation. */
  implementationPhase?: boolean;
  /**
   * Intercept level carried from `engine_intercept.interceptLevel`.
   * Populated only on `role: 'harness'` messages pushed by the
   * `engine_intercept` handler in engine-event-slice.ts.
   * Values: "banner" (informational) | "redirect" (urgent, run aborted).
   * The InterceptBanner component reads this to choose its visual weight.
   * Client-only field — NOT part of the Go contract or wire protocol.
   */
  interceptLevel?: string;
  timestamp: number;
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * Set to true by engine_message_end so the next engine_text_delta
   * opens a fresh assistant message instead of appending to this one.
   */
  sealed?: boolean;
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * Set to true on the optimistic user bubble created by the mid-turn
   * steer path (submit → window.ion.steer). Stays true while
   * the steer is buffered in the engine runloop (e.g. during a tool
   * stall). The renderer shows a "queued" indicator while this is set.
   *
   * Resolved in one of two ways:
   *   - steer_injected arrives → the bubble becomes a normal user message
   *     and a "Steer applied" divider is appended (steerPending cleared).
   *   - engine_dead arrives before steer_injected → the bubble is marked
   *     steerFailed so the renderer can show an error affordance.
   */
  steerPending?: boolean;
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * Set to true when the engine died before the buffered steer was drained.
   * The renderer shows an error affordance instead of the pending indicator.
   */
  steerFailed?: boolean;
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * Set to true on the optimistic user bubble when `steer_injected` confirms
   * the engine drained it into the conversation. Marks the bubble as "this
   * user turn was a mid-turn steer" so the renderer can label it distinctly
   * from a normal turn-opening prompt.
   */
  steerApplied?: boolean;
  /**
   * How this turn was authored, as an engine InjectionKind wire value.
   *
   * Present on a turn that reached the conversation through something other
   * than the prompt box. `structured_answer` marks a Guided Questions
   * submission: real operator input (they chose the options, typed the text,
   * attached the images) that the renderer LABELS rather than hides, so the
   * transcript never implies they typed the rendered form.
   *
   * Machine-authored kinds are filtered before they ever become a Message
   * (shared/injection-policy.ts), so this field is for presentation, not
   * suppression.
   */
  injectionKind?: string;
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * The `id` of the "── Steer applied" divider that `steer_injected` appended
   * for this bubble. The two rows share this key so the grouping pass
   * (groupMessages / groupMessagesUnified in tool-helpers.ts) can RELOCATE the
   * bubble out of its send position and re-emit it directly after its divider —
   * the point in the scrollback where the steer actually took effect.
   *
   * Live-session only. The optimistic bubble is inserted where the user typed
   * it, but the engine applies the steer later; without this pairing the text
   * is stranded rows above the divider that announces it. After a restart the
   * engine's conversation file already carries the turn at its true applied
   * position and this field is absent, so no relocation happens (and none is
   * needed).
   */
  steerAppliedDividerId?: string;
  // ─── Extended-thinking fields (issue #158) ───
  // Populated ONLY on `role: 'thinking'` messages, which the renderer
  // synthesizes from the engine's `engine_thinking_block_start` /
  // `engine_thinking_delta` / `engine_thinking_block_end` event trio.
  // A thinking block is OPTIONAL per turn; most turns carry none. The
  // ThinkingBlock component (rendered above the tool row in a turn)
  // reads these to pick one of three render states:
  //   - Live:         thinkingActive=true (between start and end). Pulse
  //                   indicator + tail of `content` streaming in.
  //   - Historical:   thinkingActive=false with non-empty `content`
  //                   (deltas were captured). Collapsed → tail; expand →
  //                   full text.
  //   - Summary-only: thinkingActive=false with empty `content` — deltas
  //                   were disabled engine-side, the block was redacted,
  //                   or the message was rehydrated from persistence
  //                   without text. Renders the elapsed/token summary (or
  //                   the redacted affordance) and never promises text.
  // All three are local UI state derived from engine events; none are
  // part of the Go wire contract. Thinking messages are intentionally
  // dropped from persistence (see serialize-conversation-pane.ts) so the
  // tabs file does not balloon with streamed reasoning text; a rehydrated
  // conversation simply has no thinking rows, which is the correct
  // summary-absent default.
  /** True while the block is streaming (between block_start and block_end). */
  thinkingActive?: boolean;
  /** Wall-clock seconds the reasoning block took, from block_end. */
  thinkingElapsedSeconds?: number;
  /** Token count the model spent reasoning, from block_end (when present). */
  thinkingTotalTokens?: number;
  /**
   * True when the engine reported the block as encrypted/redacted
   * reasoning with no readable text. The ThinkingBlock renders a
   * "🔒 redacted reasoning" affordance rather than an empty block.
   */
  thinkingRedacted?: boolean;
  backgroundWork?: import("./types-background-work").BackgroundWorkInfo;
  backgroundTaskId?: string;
}

export interface RunResult {
  /** Cost of this run in USD. Populated from TaskCompleteEvent.costUsd which
   *  the engine sets to a per-run value (cache-aware, CliBackend delta-normalized). */
  totalCostUsd: number;
  durationMs: number;
  /** Terminal reason for this run. Drives the transcript completion label. */
  reason?: import("./types-events").TaskCompletionReason | (string & {});
  numTurns: number;
  /** Conversation-lifetime prompt count (real user prompts across the whole
   *  conversation), from TaskCompleteEvent.conversationTurns. Distinct from
   *  numTurns (per-run round-trips). The StatusDrawer "Turns" row renders this
   *  lifetime value. Absent on paths that do not report it (e.g. CLI backend). */
  conversationTurns?: number;
  usage: UsageData;
  sessionId: string;
}

// ─── Run Options ───

/**
 * Optional authorship + location facts carried alongside a mid-run Steer, so the
 * main process can emit the Desktop Automation `conversation:message-submitted`
 * event with the same classification a fresh prompt gets. Every field is
 * optional; a caller that omits the object keeps the legacy positional shape and
 * main falls back to reclassifying and to the session's own tab status.
 */
export interface SteerMeta {
  projectPath?: string;
  worktreePath?: string;
  source?: "desktop" | "remote" | "machine";
  injectionKind?: string;
  messageKind?: import("./automation-message-kind").AutomationMessageKind;
}

export interface RunOptions {
  prompt: string;
  projectPath: string;
  /** Conversation ID to resume (loads existing conversation history) */
  sessionId?: string;
  model?: string;
  /** Extra directories to add (session-preserving) */
  addDirs?: string[];
  /** Extra context appended to the system prompt (additive, not replacement) */
  appendSystemPrompt?: string;
  /**
   * Origin of the prompt. 'remote' skips iOS forwarding (already echoed).
   * 'machine' is a renderer-local marker (e.g. the auto-fix lock passage): it
   * behaves as a local prompt for delivery and echo (echo stays keyed on
   * 'remote'), but is retained here so Desktop Automation can classify the
   * submission as machine-authored.
   */
  source?: "desktop" | "remote" | "machine";
  /**
   * Client-classified authorship for the Desktop Automation
   * `conversation:message-submitted` event. Computed once at the send boundary
   * so the fresh-prompt and steer paths agree. Absent → main reclassifies.
   */
  messageKind?: import("./automation-message-kind").AutomationMessageKind;
  /** Main-originated turn must be published to iOS after renderer acceptance. */
  echoToIos?: boolean;
  /** Stable client delivery identity. Reused on retries to make engine acceptance idempotent. */
  deliveryId?: string;
  /**
   * Optional transcript text when the user-facing rendering differs from the
   * provider prompt. The engine persists this as display content and keeps
   * `prompt` as provider-visible context. Used by structured client surfaces.
   */
  displayText?: string;
  /**
   * How this turn was authored, as an engine InjectionKind wire value.
   * 'structured_answer' marks a Guided Questions submission — the operator
   * chose the values in the wizard, so the engine classifies the turn
   * user-authored but delivered through a structured surface, so the
   * transcript renders it with a "Questions answered" label instead of as
   * text the operator typed at the prompt. Absent for an ordinary typed turn.
   */
  injectionKind?: string;
  /** Max output tokens per LLM turn */
  maxTokens?: number;
  /** Extended thinking config (per-session default). See ThinkingConfig. */
  thinking?: import("./types-engine").ThinkingConfig;
  /** Extension entry points for engine tabs (resolved from engine profile) */
  extensions?: string[];
  /**
   * Tells the engine that this run is the "implement" half of a
   * plan-then-implement flow. The desktop sets this on the run dispatched
   * by the Implement button on the plan-approval card. The engine
   * responds by suppressing the EnterPlanMode sentinel tool injection so
   * the model cannot re-propose a plan-mode entry against the user's
   * already-approved intent.
   *
   * Replaces the prior mechanism, which was the desktop prepending a
   * "You are implementing a user-approved plan. Do not re-enter plan
   * mode..." preamble to the user prompt and the EnterPlanMode tool's
   * docstring telling the model to recognize those phrases. The boolean
   * is the mechanical equivalent and lives on the structured wire
   * contract instead of in prompt prose.
   */
  implementationPhase?: boolean;
  /**
   * Per-prompt extended-thinking effort for this CLI/conversation prompt.
   * 'off'/undefined → no thinking directive. Threaded to send_prompt as
   * `thinkingEffort`; read from the conversation instance's level.
   */
  thinkingEffort?: string;
  /**
   * Harness-supplied description prose for the EnterPlanMode sentinel
   * tool that the engine injects during auto-mode runs. The desktop
   * supplies this from the ENTER_PLAN_MODE_DESCRIPTION constant in
   * prompt-pipeline.ts on every prompt that wants the full plan-mode
   * framing; the engine forwards it verbatim to the LLM as the tool's
   * description.
   *
   * Per ADR-004 (Move EnterPlanMode prose to harness): the policy
   * prose that tells the model WHEN to enter plan mode and WHAT the
   * rules are once enabled belongs in the harness, not the engine.
   * The engine ships only a one-line neutral fallback used when this
   * field is empty / omitted; third-party harnesses pick their own
   * (TUIs, domain-specific harnesses, etc.).
   *
   * Skipping this field on the "implement" half of a plan-then-
   * implement flow is harmless — the engine already suppresses
   * EnterPlanMode injection when implementationPhase=true, so any
   * description value would be unused.
   */
  enterPlanModeDescription?: string;
  /**
   * Harness-supplied text for the per-turn sparse plan-mode reminder the
   * engine injects every planModeReminderInterval turns (default: every 5).
   * When non-empty, the engine uses this string verbatim instead of building
   * the reminder from the plan file path.
   *
   * Parallel override to enterPlanModeDescription: same additive optional
   * contract. Omit or leave empty to inherit the engine's default reminder.
   * The desktop ships its reference prose as PLAN_MODE_SPARSE_REMINDER in
   * prompt-pipeline.ts; third-party harnesses pick their own or omit.
   */
  planModeSparseReminder?: string;
  /**
   * Pre-encoded image attachments for the user message. The engine forwards
   * each as a native multimodal content block. Desktop is responsible for
   * reading the file, base64-encoding the bytes, and dropping unreadable
   * entries before they reach the engine.
   */
  imageAttachments?: ImageAttachmentPayload[];
  /**
   * Raw (not yet encoded) file/image attachments from the desktop composer.
   * The renderer cannot encode (fs + nativeImage live in main), so it passes
   * the paths through; the prompt pipeline's desktop branch runs
   * encodeAttachments on them -- same treatment the remote branches get.
   */
  rawAttachments?: Array<{
    type: "image" | "file";
    name: string;
    path: string;
  }>;
  /**
   * Persisted plan file path from tab state. When set, the engine uses this
   * path instead of allocating a fresh slug — restoring continuity after
   * desktop restart. The engine validates that the file exists on disk; if
   * the file is missing it falls back to allocating a new slug as before.
   *
   * Only sent when tab.planFilePath is non-null. Tabs that have never
   * entered plan mode omit this field and the engine's behavior is
   * unchanged.
   */
  planFilePath?: string;
  /**
   * When true, the engine treats `prompt` as a slash invocation
   * (`/name args`): it resolves the command template across its own command
   * roots (`.ion/commands`, `.claude/commands`, skills, project roots),
   * expands it ($ARGUMENTS substitution + frontmatter), feeds the EXPANDED
   * body to the model, and persists the RAW invocation as the displayed user
   * turn. Default/omitted → plain message (unchanged behavior).
   *
   * The desktop sets this only on the slash re-submit path
   * (`prompt-pipeline.ts:handleSlash`) after the engine disclaims a slash with
   * `unknown_command` — handing the raw invocation back so the engine owns
   * resolution + expansion (local `.md` expansion is retired). Sent on the
   * wire only when truthy (mirrors the engine's omitempty `resolveSlash`).
   */
  resolveSlash?: boolean;
  /** Per-invocation override for a resolved slash command's model tier. */
  slashModelTierApplyMidConversation?: boolean;
  /** Main-owned automation causation, consumed by desktop IPC only. */
  automationCausation?: import("./types-automation").AutomationCausation;
  /** Runs one slash command with auto-mode tools while its plan workflow remains active. */
  temporaryAutoFromPlan?: boolean;
  /**
   * Client-supplied workspace descriptor for this prompt. When set, the
   * engine uses this instead of its own worktree-registry-derived context.
   * Per-prompt override: takes precedence over the session-level
   * EngineConfig.clientWorkspaceContext value.
   */
  clientWorkspaceContext?: import("./types-engine").ClientWorkspaceContext;
}

/** Pre-encoded image bytes that ride alongside a user prompt. */
export interface ImageAttachmentPayload {
  /** SHA-256 identity of original user-visible image bytes. */
  contentHash?: string;
  /** MIME type, e.g. "image/jpeg", "image/png", "image/webp", "image/gif". */
  mediaType: string;
  /** Base64-encoded image bytes (no data URL prefix). */
  data: string;
  /** Source path on disk; carried for logging only. */
  path?: string;
}

// ─── Control Plane Types ───

export interface TabRegistryEntry {
  tabId: string;
  conversationId: string | null;
  status: TabStatus;
  activeRequestId: string | null;
  runPid: number | null;
  createdAt: number;
  lastActivityAt: number;
  promptCount: number;
}

export interface HealthReport {
  tabs: Array<{
    tabId: string;
    status: TabStatus;
    activeRequestId: string | null;
    conversationId: string | null;
    alive: boolean;
    lastActivityAt: number;
  }>;
  queueDepth: number;
}

export interface EnrichedError {
  message: string;
  stderrTail: string[];
  stdoutTail?: string[];
  exitCode: number | null;
  elapsedMs: number;
  toolCallCount: number;
  sawPermissionRequest?: boolean;
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string }>;
}

// ─── Session History ───

export interface SessionMeta {
  sessionId: string;
  slug: string | null;
  firstMessage: string | null;
  lastResponse: string | null;
  firstTimestamp?: string;
  lastTimestamp: string;
  size: number;
  customTitle: string | null;
  /** Decoded real filesystem path (null if directory no longer exists) */
  projectPath: string | null;
  /** Human-readable label (basename of path, or fallback from encoded name) */
  projectLabel: string | null;
  /** Raw encoded directory name (for loading sessions from deleted dirs) */
  encodedDir: string | null;
  /** All session IDs in this composite conversation chain (including self) */
  chainSessionIds?: string[];
  /** Number of sessions in the chain (1 = standalone) */
  chainLength?: number;
}

/** Maps root session IDs to their continuation chains for composite conversation grouping */
export interface SessionChainIndex {
  /** root session ID -> ordered list of continuation session IDs */
  chains: Record<string, string[]>;
  /** any continuation session ID -> its root session ID */
  reverse: Record<string, string>;
}

export interface SessionLoadMessage {
  /**
   * Canonical row id (mirror of `types.SessionMessage.ID`): the persisted
   * tree entry id for the first row an entry produces, `<entryId>:<n>` for
   * subsequent rows. Stable across reloads — clients key history rows on it,
   * and live rows re-key to it at `message_end` (entryId / userEntryId), so
   * reloads dedup against live rows instead of duplicating them. Absent only
   * when the engine predates the field.
   */
  id?: string;
  role: string;
  content: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  userExecuted?: boolean;
  attachments?: Attachment[];
  timestamp: number;
  backgroundTaskId?: string;
  internal?: boolean;
  /**
   * Persisted tool_result error flag on tool rows (mirror of
   * `types.SessionMessage.IsError`) so reloaded history keeps failed tool
   * state instead of coercing every result to success.
   */
  isError?: boolean;
  /** Engine-provided slash-command metadata (see Message.slashCommand). */
  slashCommand?: string;
  slashArgs?: string;
  slashSource?: string;
  slashModelAlias?: string;
  slashModelEffective?: string;
  /** Complete parsed command frontmatter, including extension-defined keys. */
  slashFrontmatter?: Record<string, unknown>;
  /** True when this persisted user turn starts an approved plan implementation. */
  implementationPhase?: boolean;
  /**
   * Marker payload fields (additive, omitempty on the wire). Set only when
   * `role === 'system'` and this row is a persisted marker entry (compaction,
   * plan, steer, clear) the engine's `flattenEntries` replays on historical
   * reload. The engine emits structured data, not display strings; the desktop
   * formats the divider content from these fields using its existing formatters
   * (see shared/session-message-mapper.ts). `markerKind` discriminates the
   * family. Mirror of `types.SessionMessage.Marker*` in
   * engine/internal/types/types.go.
   */
  markerKind?: string; // "compaction" | "plan" | "steer" | "clear"
  /** Compaction marker fields (markerKind === 'compaction'). */
  markerMessagesBefore?: number;
  markerMessagesAfter?: number;
  markerClearedBlocks?: number;
  markerStrategy?: string;
  markerMicroOnly?: boolean;
  markerSummary?: string;
  /** Plan marker fields (markerKind === 'plan'). */
  markerPlanOperation?: string;
  markerPlanFilePath?: string;
  markerPlanSlug?: string;
  /** Steer marker fields (markerKind === 'steer'). */
  markerMessageLength?: number;
  /** Steer marker machine-authored classification. */
  markerMachineAuthored?: boolean;
  machineAuthored?: boolean;
  /** Structured completion delivery metadata. */
  backgroundWork?: import("./types-events").BackgroundWorkInfo;
  /**
   * Classifies engine-side injected user turns on historical reload.
   * "agent_completion" marks a machine-to-machine dispatch callback (a child
   * agent's result routed to its parent) rather than a user-authored turn.
   * Absent (or empty string) means an ordinary user turn. Additive: absent on
   * legacy history rows, which correctly read as ordinary turns.
   */
  injectionKind?: string;
}

// ─── Terminal Multiplexing ───

export type TerminalInstanceKind = string; // 'user' | 'commit' | 'cli' | 'tool:<toolId>'

export interface TerminalInstance {
  id: string; // nanoid
  label: string; // "Shell", "Commit", "CLI", "Shell 2", tool name
  kind: TerminalInstanceKind;
  readOnly: boolean;
  cwd: string;
}

// ─── Quick Tools ───

export interface QuickTool {
  id: string; // UUID
  name: string; // display label, e.g. "Merge Flow"
  icon: string; // Phosphor icon name, e.g. "GitMerge"
  command: string; // shell command with optional {cwd} and {branch} vars
  directories?: string[]; // scoped base dirs (empty = available in all tabs)
}

export interface TerminalPaneState {
  instances: TerminalInstance[];
  activeInstanceId: string | null;
}

// ─── Git Types ───
//
// Git types live in types-git.ts (extracted to keep this file under the
// 600-line cap). Re-exported here so existing import paths keep working.
export type {
  GitCommit,
  GitRef,
  GitCommitDetail,
  GitCommitFile,
  GitGraphData,
  GitConflictKind,
  GitDiffResult,
  GitChangedFile,
  GitChangesData,
  GitBranchInfo,
  LandMode,
  LandResult,
  WorktreeMoveResult,
  WorktreeInventoryEntry,
  WorktreeAppraisalWire,
  WorktreeProvisionState,
  GitOperationState,
  WorkStage,
  WorkStageDescriptor,
  SyncAllResult,
  SyncAllWorktreeOutcome,
  PinState,
  MergeOutcome,
  IntegrationMember,
  IntegrationWorkspace,
  BenchAssembleResult,
  WorktreePinAdvance,
} from "./types-git";

// ─── Worktree Types ───

export type GitOpsMode = "manual" | "worktree";
export type WorktreeCompletionStrategy = "merge-ff" | "merge" | "pr";

export interface WorktreeInfo {
  /** Physical path on disk (~/.ion/worktrees/...) */
  worktreePath: string;
  /** Auto-generated branch name (wt/<nanoid>) */
  branchName: string;
  /** Branch the worktree was created from */
  sourceBranch: string;
  /** Original repo root path */
  repoPath: string;
  /** Terminal witness written by successful Land; absent before then. */
  landedAt?: number;
}

export interface WorktreeStatus {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  isMerged: boolean;
  aheadCount: number;
  behindCount: number;
}

// ─── Filesystem Types ───

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedMs: number;
}

// ─── Engine-host filesystem (browsed via the engine, may be remote) ───

/** One entry in a list_directory response from the engine. */
export interface EngineDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  readable: boolean;
}

/** Response of the engine's list_directory RPC. */
export interface EngineDirListing {
  path: string;
  parent: string | null;
  entries: EngineDirEntry[];
  truncated: boolean;
}

/** Response of the engine's get_host_info RPC. */
export interface EngineHostInfo {
  home: string;
  username: string;
  hostname: string;
  os: string;
  pathSep: string;
}

/**
 * Wire shape for the engine's get_enterprise_policy RPC response.
 * Mirrors Go's NewConversationDefaultsPolicy in internal/types/config.go.
 * null means no enterprise config or no NewConversationDefaults section.
 */
export interface NewConversationDefaultsPolicy {
  /** Mandated working directory for new tabs. Empty string = no constraint. */
  baseDirectory: string;
  /**
   * Mandated engine profile id. Empty string = plain conversation (no
   * extension). Must match an id in the user's engineProfiles list.
   */
  engineProfileId: string;
  /**
   * When true, the user cannot change baseDirectory or engineProfileId.
   * The desktop skips both the directory picker and the profile picker and
   * opens the conversation directly with these values.
   */
  locked: boolean;
  /** Enterprise-owned Projects visible to clients but not user-editable. */
  projects?: Array<{ directory: string; name?: string; default?: boolean; profileName?: string; profileLocked?: boolean }>;
}

// ─── Remote Control Types ───

export interface RemoteSettings {
  remoteEnabled: boolean;
  relayUrl: string;
  relayApiKey: string;
  lanServerPort: number;
  pairedDevices: RemotePairedDevice[];
}

export interface RemotePairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeen: string | null;
  channelId: string;
  relayOidcAccountUsername?: string;
  relayOidcAccountName?: string;
  relayOidcTenantId?: string;
  relayOidcSignedInAt?: string;
  relayOidcAccessStatus?: string;
  relayOidcAccessReason?: string;
  relayOidcReportedAt?: string;
}

export type RemoteTransportState =
  "disconnected" | "relay_only" | "lan_preferred";
