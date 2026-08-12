// hook_payloads.go — hook payload and result structs.
//
// These mirror the engine's sdk_hook_types.go field for field, JSON tag for
// JSON tag. The mirror exists for the same reason types.ts does: the engine's
// definitions live under internal/, which the Go compiler will not let an
// external module import. Importing them is not an option, so they are
// restated here and the parity test pins them to the engine's contract
// manifest — a field added on the engine side and not here is a test failure.
//
// Payload structs for lifecycle, session, content, permission, and plan-mode
// hooks live here. Tool-related payloads are in hook_payloads_tools.go.
package ion

// --- Lifecycle ---

// TurnInfo is the payload for turn_start and turn_end.
type TurnInfo struct {
	TurnNumber int `json:"turnNumber"`
}

// AgentInfo is the payload for agent_start, agent_end, and
// before_agent_start.
type AgentInfo struct {
	// Name is the agent's name.
	Name string `json:"name"`
	// Task is the task the agent was dispatched with.
	Task string `json:"task,omitempty"`
	// IsRoot distinguishes the root conversation's own agent firing from a
	// dispatched sub-agent. A handler that appends a persona must check it:
	// the root firing is the conversation itself, not a delegate.
	IsRoot bool `json:"isRoot,omitempty"`
	// RemainingDepthBudget is the number of child dispatch levels available
	// under the effective depth cap. It is present only on before_agent_start.
	RemainingDepthBudget int `json:"remainingDepthBudget,omitempty"`
}

// BeforeAgentStartResult is the result of a before_agent_start handler.
type BeforeAgentStartResult struct {
	// SystemPrompt is appended to the agent's system prompt. Empty abstains.
	SystemPrompt string `json:"systemPrompt,omitempty"`
	// AgentName overrides the agent's name. Empty abstains.
	AgentName string `json:"agentName,omitempty"`
}

// BeforePromptResult is the result of a before_prompt handler.
type BeforePromptResult struct {
	// Prompt replaces the user's prompt. Empty means no change.
	Prompt string `json:"prompt,omitempty"`
	// SystemPrompt is appended to the system prompt. Empty means no change.
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

// ErrorInfo is the payload for on_error.
type ErrorInfo struct {
	Message      string `json:"message"`
	ErrorCode    string `json:"errorCode,omitempty"`
	Category     string `json:"category,omitempty"`
	Retryable    bool   `json:"retryable,omitempty"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
}

// --- Session management ---

// CompactionFact is one extracted fact carried in CompactionInfo.
type CompactionFact struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// CompactionInfo is the payload for session_before_compact and
// session_compact.
type CompactionInfo struct {
	Strategy         string           `json:"strategy"`
	MessagesBefore   int              `json:"messagesBefore"`
	MessagesAfter    int              `json:"messagesAfter"`
	Facts            []CompactionFact `json:"facts,omitempty"`
	TokensBefore     int              `json:"tokensBefore,omitempty"`
	TokenLimit       int              `json:"tokenLimit,omitempty"`
	TargetTokens     int              `json:"targetTokens,omitempty"`
	MicroCompactKeep int              `json:"microCompactKeep,omitempty"`
	TokensAfter      int              `json:"tokensAfter,omitempty"`
	SessionMemory    string           `json:"sessionMemory,omitempty"`
}

// ForkInfo is the payload for session_before_fork and session_fork.
type ForkInfo struct {
	SourceSessionKey string `json:"sourceSessionKey"`
	NewSessionKey    string `json:"newSessionKey"`
	ForkMessageIndex int    `json:"forkMessageIndex"`
}

// CompactSummaryRequestInfo is the payload for compact_summary_request. The
// message slice is already cut at the last boundary, so prior summaries are
// not re-scanned.
type CompactSummaryRequestInfo struct {
	Strategy     string `json:"strategy"`
	MessageCount int    `json:"messageCount"`
	// Messages are engine LlmMessage values. Typed loosely because the
	// message wire shape belongs to the engine's conversation layer, not to
	// the extension contract.
	Messages []map[string]any `json:"messages"`
}

// CompactSummaryRequestResult is the result of a compact_summary_request
// handler. A non-empty Summary replaces the engine's regex-built summary;
// empty abstains and the engine falls back to its own extractor.
type CompactSummaryRequestResult struct {
	Summary string `json:"summary,omitempty"`
}

// SessionMessageInfo is the payload for session_message, fired when another
// session of the same extension sends a message.
type SessionMessageInfo struct {
	SenderSessionKey string         `json:"senderSessionKey"`
	Kind             string         `json:"kind"`
	Payload          map[string]any `json:"payload"`
}

// --- Content ---

// MessageUpdateInfo is the payload for message_update.
type MessageUpdateInfo struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ModelSelectInfo is the payload for model_select. A handler returns a model
// name to override the engine's selection.
type ModelSelectInfo struct {
	RequestedModel  string   `json:"requestedModel"`
	AvailableModels []string `json:"availableModels,omitempty"`
	Prompt          string   `json:"prompt,omitempty"`
}

// SlashCommandResolvedInfo is the payload for slash_command_resolved. The
// frontmatter map is complete — including keys the engine itself ignores — so
// an extension can branch on its own conventions.
type SlashCommandResolvedInfo struct {
	// Command is the invoked command, e.g. "/diagram".
	Command string `json:"command"`
	// Args is the raw argument string after the command name.
	Args string `json:"args"`
	// Source is where the command resolved from:
	// extension|ion|claude|skill|project.
	Source string `json:"source"`
	// Frontmatter is the command file's full frontmatter map.
	Frontmatter map[string]any `json:"frontmatter"`
	// ExpandedBody is the engine's expansion. Returning a string from the
	// handler overrides it.
	ExpandedBody string `json:"expandedBody"`
}

// --- Context discovery ---

// ContextDiscoverInfo is the payload for context_discover. Returning false
// excludes the file.
type ContextDiscoverInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

// ContextLoadInfo is the payload for context_load and instruction_load.
type ContextLoadInfo struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

// ContextRejectionResult is the result of a context_load or instruction_load
// handler: supply replacement content, or reject the file outright.
type ContextRejectionResult struct {
	Content string `json:"content,omitempty"`
	Reject  bool   `json:"reject,omitempty"`
}

// ContextInjectInfo is the payload for context_inject.
type ContextInjectInfo struct {
	WorkingDirectory string                  `json:"workingDirectory"`
	DiscoveredPaths  []string                `json:"discoveredPaths"`
	Workspace        *WorkspacePromptContext `json:"workspace,omitempty"`
}

// WorkspacePromptContext describes the conversation workspace. Bench and
// Client are consumer-supplied opaque maps; Worktree is engine-owned registry
// data when Kind is "worktree".
type WorkspacePromptContext struct {
	Kind     string           `json:"kind"`
	Cwd      string           `json:"cwd"`
	Worktree *WorktreeContext `json:"worktree,omitempty"`
	Bench    map[string]any   `json:"bench,omitempty"`
	Client   map[string]any   `json:"client,omitempty"`
}

// WorktreeContext describes a registered worktree and its sibling checkouts.
type WorktreeContext struct {
	WorktreePath string           `json:"worktreePath"`
	RepoPath     string           `json:"repoPath"`
	BranchName   string           `json:"branchName,omitempty"`
	SourceBranch string           `json:"sourceBranch,omitempty"`
	Title        string           `json:"title,omitempty"`
	Landed       bool             `json:"landed,omitempty"`
	Siblings     []SiblingContext `json:"siblings,omitempty"`
}

// SiblingContext describes another worktree from the same repository.
type SiblingContext struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName,omitempty"`
	Title        string `json:"title,omitempty"`
}

// --- Permissions ---

// PermissionRequestInfo is the payload for permission_request.
type PermissionRequestInfo struct {
	ToolName string         `json:"tool_name"`
	Input    map[string]any `json:"input"`
	Decision string         `json:"decision"`
	RuleName string         `json:"rule_name,omitempty"`
	Tier     string         `json:"tier,omitempty"`
}

// PermissionClassifyInfo is the payload for permission_classify. A handler
// returns the classification string.
type PermissionClassifyInfo struct {
	ToolName string         `json:"tool_name"`
	Input    map[string]any `json:"input"`
}

// PermissionDeniedInfo is the payload for permission_denied.
type PermissionDeniedInfo struct {
	ToolName string         `json:"tool_name"`
	Input    map[string]any `json:"input"`
	Reason   string         `json:"reason"`
}

// --- Files ---

// FileChangedInfo is the payload for file_changed, which fires only after the
// model's Write or Edit tool succeeds. External edits do not fire it — use
// workspace_file_changed for those.
type FileChangedInfo struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

// WorkspaceFileChangedInfo is the payload for workspace_file_changed, which
// fires for any non-ignored change under the session's working directory
// regardless of what made it.
type WorkspaceFileChangedInfo struct {
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	Action  string `json:"action"`
}

// --- Tasks ---

// TaskLifecycleInfo is the payload for task_created and task_completed, which
// are TURN lifecycle hooks.
type TaskLifecycleInfo struct {
	TaskID string         `json:"task_id"`
	Name   string         `json:"name,omitempty"`
	Status string         `json:"status,omitempty"`
	Extra  map[string]any `json:"extra,omitempty"`
}

// BackgroundTaskCompletedInfo is the payload for background_task_completed,
// which reports a background shell command reaching a terminal state. Distinct
// from task_completed, which is about turns.
type BackgroundTaskCompletedInfo struct {
	TaskID           string   `json:"task_id"`
	SessionKey       string   `json:"session_key"`
	Command          string   `json:"command,omitempty"`
	Status           string   `json:"status"`
	ExitCode         int      `json:"exit_code"`
	ElapsedMs        int64    `json:"elapsed_ms"`
	OutputPath       string   `json:"output_path,omitempty"`
	Tail             string   `json:"tail,omitempty"`
	RemainingTaskIDs []string `json:"remaining_task_ids,omitempty"`
}

// DispatchLostInfo is the payload for dispatch_lost: a dispatch that was
// running when the engine process died and is unrecoverable after restart.
//
// Fires during dispatch-state rehydration at session start, once per lost
// dispatch. Observe-only, and the engine has already acted by the time a
// handler runs — the typed engine_dispatch_lost event is emitted and the
// rehydrated agent-state row is marked "error". The hook exists so a harness
// can respond: redispatch the task, harvest the child's partial transcript
// from the conversation store via ChildConversationID, or notify its
// orchestrator. The engine never resurrects a lost dispatch.
type DispatchLostInfo struct {
	// DispatchID is the lost dispatch's collision-safe unique ID.
	DispatchID string `json:"dispatch_id"`
	// AgentName is the dispatched agent's name.
	AgentName string `json:"agent_name"`
	// Task is the task brief the dispatch was running.
	Task string `json:"task,omitempty"`
	// ParentDispatchID names the dispatch that spawned this one; empty for
	// a top-level dispatch.
	ParentDispatchID string `json:"parent_dispatch_id,omitempty"`
	// Depth is the persisted nesting depth attribution.
	Depth int `json:"depth,omitempty"`
	// ChildConversationID is the child session's conversation ID when known —
	// the handle for harvesting the partial transcript from disk.
	ChildConversationID string `json:"child_conversation_id,omitempty"`
}

// --- Elicitation ---

// ElicitationRequestInfo is the payload for elicitation_request.
type ElicitationRequestInfo struct {
	RequestID string         `json:"request_id"`
	Schema    map[string]any `json:"schema,omitempty"`
	URL       string         `json:"url,omitempty"`
	Mode      string         `json:"mode"`
}

// ElicitationResultInfo is the payload for elicitation_result.
type ElicitationResultInfo struct {
	RequestID string         `json:"request_id"`
	Response  map[string]any `json:"response,omitempty"`
	Cancelled bool           `json:"cancelled"`
}

// --- Plan mode ---

// PlanModeEnterInfo is the payload for before_plan_mode_enter.
type PlanModeEnterInfo struct {
	Source string `json:"source"`
}

// BeforePlanModeEnterResult vetoes or permits entering plan mode. Allow is a
// pointer so nil means "no opinion", distinct from an explicit false.
type BeforePlanModeEnterResult struct {
	Allow  *bool  `json:"allow,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// BeforePlanModeExitInfo is the payload for before_plan_mode_exit.
type BeforePlanModeExitInfo struct {
	PlanFilePath string `json:"planFilePath"`
	Source       string `json:"source"`
}

// BeforePlanModeExitResult vetoes or permits leaving plan mode.
type BeforePlanModeExitResult struct {
	Allow  *bool  `json:"allow,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// BeforePlanModeAutoExitInfo is the payload for before_plan_mode_auto_exit,
// fired when the engine is about to leave plan mode on its own.
type BeforePlanModeAutoExitInfo struct {
	SessionID     string   `json:"sessionId"`
	RunID         string   `json:"runId"`
	StopReason    string   `json:"stopReason"`
	PlanFilePath  string   `json:"planFilePath"`
	AssistantText string   `json:"assistantText"`
	EmittedTools  []string `json:"emittedTools,omitempty"`
}

// BeforePlanModeAutoExitResult suppresses or redirects an automatic exit.
type BeforePlanModeAutoExitResult struct {
	Suppress     bool   `json:"suppress,omitempty"`
	PlanFilePath string `json:"planFilePath,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// SystemInjectInfo is the payload for system_inject, fired before the engine
// injects any system message. Kind carries the reason.
type SystemInjectInfo struct {
	// Kind is the injection reason: plan_mode_reminder, turn_limit_warning,
	// max_token_continue, early_stop_continue, workspace_context.
	Kind string `json:"kind"`
	// DefaultText is the engine's own injection text.
	DefaultText string `json:"defaultText"`
	// Turn is the current turn number.
	Turn int `json:"turn"`
	// MaxTurns is the configured cap; 0 means unlimited.
	MaxTurns int `json:"maxTurns"`
	// Workspace carries structured workspace context for workspace_context.
	Workspace *WorkspacePromptContext `json:"workspace,omitempty"`
}

// --- Early stop ---

// EarlyStopDecisionInfo is the payload for before_early_stop_decision, fired
// when the engine is weighing whether to nudge the model to keep working.
type EarlyStopDecisionInfo struct {
	RunID                  string `json:"runId"`
	Model                  string `json:"model"`
	TurnNumber             int    `json:"turnNumber"`
	StopReason             string `json:"stopReason"`
	CumulativeOutputTokens int    `json:"cumulativeOutputTokens"`
	Budget                 int    `json:"budget"`
	ThresholdPct           int    `json:"thresholdPct"`
	ContinuationCount      int    `json:"continuationCount"`
	MaxContinuations       int    `json:"maxContinuations"`
	LastContinuationDelta  int    `json:"lastContinuationDelta"`
	IsSubagent             bool   `json:"isSubagent"`
	WouldContinue          bool   `json:"wouldContinue"`
}

// EarlyStopDecisionResult overrides the engine's early-stop decision.
// ForceContinue is a pointer so nil means "no opinion".
type EarlyStopDecisionResult struct {
	ForceContinue        *bool  `json:"forceContinue,omitempty"`
	OverrideBudget       int    `json:"overrideBudget,omitempty"`
	OverrideThresholdPct int    `json:"overrideThresholdPct,omitempty"`
	ContinueMessage      string `json:"continueMessage,omitempty"`
}

// EarlyStopContinuedInfo is the payload for early_stop_continued, fired after
// a continuation nudge went out.
type EarlyStopContinuedInfo struct {
	RunID                  string `json:"runId"`
	TurnNumber             int    `json:"turnNumber"`
	ContinuationCount      int    `json:"continuationCount"`
	Pct                    int    `json:"pct"`
	CumulativeOutputTokens int    `json:"cumulativeOutputTokens"`
	Budget                 int    `json:"budget"`
	InjectedText           string `json:"injectedText"`
}

// --- Capabilities ---

// CapabilityMatchInfo is the payload for capability_match.
type CapabilityMatchInfo struct {
	// Input is the user's raw input.
	Input string `json:"input"`
	// Capabilities lists every registered capability ID.
	Capabilities []string `json:"capabilities"`
}

// --- Extension lifecycle ---

// ExtensionRespawnedInfo is the payload for extension_respawned, fired at this
// extension after the engine auto-respawns it.
type ExtensionRespawnedInfo struct {
	AttemptNumber int    `json:"attemptNumber"`
	PrevExitCode  *int   `json:"prevExitCode,omitempty"`
	PrevSignal    string `json:"prevSignal,omitempty"`
}

// TurnAbortedInfo is the payload for turn_aborted.
type TurnAbortedInfo struct {
	Reason string `json:"reason"`
}

// PeerExtensionInfo is the payload for peer_extension_died and
// peer_extension_respawned.
type PeerExtensionInfo struct {
	Name          string `json:"name"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	Signal        string `json:"signal,omitempty"`
	AttemptNumber int    `json:"attemptNumber,omitempty"`
}

// --- Async-trigger registration ---

// AsyncRegistrationInfo is the payload for the four registration lifecycle
// hooks: webhook_registered, webhook_deregistered, schedule_registered, and
// schedule_deregistered.
type AsyncRegistrationInfo struct {
	// Kind is "webhook" or "schedule".
	Kind string `json:"kind"`
	// ID is the declaration's stable identifier within its kind: the webhook
	// path, or the schedule job id.
	ID string `json:"id"`
	// Origin is "init" or "runtime", distinguishing the bulk handshake from a
	// dynamic add or remove.
	Origin string `json:"origin"`
	// Decl is the typed declaration — a WebhookRoute or a ScheduleJob.
	Decl map[string]any `json:"decl,omitempty"`
}

// AsyncRegistrationVeto refuses a registration from a *_registered handler.
// Reason reaches the registering extension verbatim. The *_deregistered hooks
// cannot veto: letting one extension trap another's resources would be a
// footgun.
type AsyncRegistrationVeto struct {
	Block  bool   `json:"block"`
	Reason string `json:"reason,omitempty"`
}

// ScheduleMissedInfo is the payload for schedule_missed, fired when the
// scheduler finds a daily or weekly slot that elapsed while the engine was
// down.
type ScheduleMissedInfo struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// MissedSlotUtc is the RFC3339 UTC timestamp of the missed slot.
	MissedSlotUtc string `json:"missedSlotUtc"`
	// HadMarker reports whether a last-run marker existed on disk. False
	// means the job was registered before but had never run successfully.
	HadMarker bool `json:"hadMarker"`
	// RanWithinScope reports whether the job ran at least once inside the
	// current scope window (today for daily, this week for weekly).
	RanWithinScope bool `json:"ranWithinScope"`
}
