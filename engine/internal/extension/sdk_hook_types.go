package extension

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// --- Fire method payload types ---

// ToolCallInfo describes a tool invocation for the tool_call hook.
type ToolCallInfo struct {
	ToolName string                 `json:"toolName"`
	ToolID   string                 `json:"toolId"`
	Input    map[string]interface{} `json:"input"`
}

// ToolCallResult is the combined result of tool_call handlers.
type ToolCallResult struct {
	Block  bool   `json:"block"`
	Reason string `json:"reason,omitempty"`
}

// ToolStartInfo describes a tool starting for the tool_start hook.
type ToolStartInfo struct {
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
}

// ErrorCategory classifies engine errors.
type ErrorCategory string

const (
	ErrorCategoryTool       ErrorCategory = "tool_error"
	ErrorCategoryProvider   ErrorCategory = "provider_error"
	ErrorCategoryPermission ErrorCategory = "permission_error"
	ErrorCategoryMcp        ErrorCategory = "mcp_error"
	ErrorCategoryCompaction ErrorCategory = "compaction_error"
)

// ErrorInfo describes an error for the on_error hook.
type ErrorInfo struct {
	Message      string        `json:"message"`
	ErrorCode    string        `json:"errorCode,omitempty"`
	Category     ErrorCategory `json:"category,omitempty"`
	Retryable    bool          `json:"retryable,omitempty"`
	RetryAfterMs int64         `json:"retryAfterMs,omitempty"`
	HttpStatus   int           `json:"httpStatus,omitempty"`
}

// CompactionFact is a single structured fact extracted from messages that
// were about to be compacted away. Surfaced on the session_compact hook so
// extensions maintaining external memory (vector stores, knowledge graphs,
// SQLite) can durably persist them before the source messages are discarded.
//
// Type is one of: "decision", "file_mod", "error", "preference", "discovery".
// Content is a short human-readable snippet (sentence or path).
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type CompactionFact struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// CompactionInfo describes a compaction event.
//
// Facts carries the structured facts the engine extracted from the
// pre-compaction message set. May be empty (nil or zero-length) when the
// extractor found no matching patterns, or when only step-1 micro-compaction
// ran. Extensions should treat each CompactionFact as a self-contained
// string-pair — message indices are intentionally not exposed because they
// reference messages that no longer exist after the hook fires.
type CompactionInfo struct {
	Strategy       string           `json:"strategy"`
	MessagesBefore int              `json:"messagesBefore"`
	MessagesAfter  int              `json:"messagesAfter"`
	Facts          []CompactionFact `json:"facts,omitempty"`
}

// ForkInfo describes a session fork event.
type ForkInfo struct {
	SourceSessionKey string `json:"sourceSessionKey"`
	NewSessionKey    string `json:"newSessionKey"`
	ForkMessageIndex int    `json:"forkMessageIndex"`
}

// PerToolCallResult is the combined result of per-tool call handlers.
type PerToolCallResult struct {
	Block  bool                   `json:"block"`
	Reason string                 `json:"reason,omitempty"`
	Mutate map[string]interface{} `json:"mutate,omitempty"`
}

// ContextDiscoverInfo describes a context file discovery event.
type ContextDiscoverInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

// ContextLoadInfo describes a context file load event.
type ContextLoadInfo struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

// ContextInjectInfo is the payload for the context_inject hook.
type ContextInjectInfo struct {
	WorkingDirectory string   `json:"workingDirectory"`
	DiscoveredPaths  []string `json:"discoveredPaths"`
}

// ContextEntry is a single piece of context content to inject into the system prompt.
type ContextEntry struct {
	Label   string `json:"label"`   // identifier shown in prompt (e.g. file path)
	Content string `json:"content"` // raw content to inject
}

// CapabilityMode controls how a capability is surfaced to the LLM.
type CapabilityMode int

const (
	CapabilityModeTool   CapabilityMode = 1 << iota // surface as LLM tool
	CapabilityModePrompt                            // inject into system prompt
)

// Capability is a registered behavior that can be discovered, presented, and invoked.
type Capability struct {
	ID          string                 // unique identifier
	Name        string                 // human-readable name
	Description string                 // one-line description
	Metadata    map[string]interface{} // extension-defined (triggers, tags, etc.)
	Mode        CapabilityMode         // how the engine surfaces this
	InputSchema map[string]interface{} // JSON Schema for tool parameters (Mode includes Tool)
	Execute     func(ctx *Context, input map[string]interface{}) (*types.ToolResult, error)
	Prompt      string // injected into system prompt (Mode includes Prompt)
}

// CapabilityMatchInfo is the payload for the capability_match hook.
type CapabilityMatchInfo struct {
	Input        string   `json:"input"`        // user's raw input
	Capabilities []string `json:"capabilities"` // all registered capability IDs
}

// CapabilityMatchResult describes which capabilities matched user input.
type CapabilityMatchResult struct {
	MatchedIDs []string               `json:"matchedIds"`     // capabilities to invoke
	Args       map[string]interface{} `json:"args,omitempty"` // arguments extracted from input
}

// MessageUpdateInfo describes a message update event.
type MessageUpdateInfo struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// PermissionRequestInfo carries details about a permission request.
type PermissionRequestInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
	Decision string                 `json:"decision"`
	RuleName string                 `json:"rule_name,omitempty"`
	// Tier is the classifier label assigned by the permission_classify hook
	// (or empty when no classifier ran). Lets audit/observation handlers
	// surface the harness's risk taxonomy alongside the engine's decision.
	Tier string `json:"tier,omitempty"`
}

// PermissionClassifyInfo carries the input to a permission_classify hook
// handler. Handlers return a tier label string ("SAFE", "HIGH", "CRITICAL"
// — any taxonomy your harness defines). The first non-empty label wins.
type PermissionClassifyInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
}

// PermissionDeniedInfo carries details about a denied permission.
type PermissionDeniedInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
	Reason   string                 `json:"reason"`
}

// FileChangedInfo carries details about a file change driven by the LLM's
// Write or Edit tool. See the doc on HookFileChanged for the scope of when
// this fires (LLM-write only -- it is NOT a filesystem watcher).
type FileChangedInfo struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

// WorkspaceFileChangedInfo carries details about a filesystem event inside
// the session's working directory, observed by the engine-owned recursive
// watcher. Unlike FileChangedInfo this fires regardless of who wrote the
// file (LLM tools, the user's editor, shell scripts, etc.).
//
// Path is absolute and OS-native; RelPath is forward-slash separated and
// relative to EngineConfig.WorkingDirectory so consumers can glob-match
// portably. Action is one of "create", "modify", "delete". Rename is
// reported as paired delete+create -- cross-editor rename detection is
// unreliable.
type WorkspaceFileChangedInfo struct {
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	Action  string `json:"action"`
}

// TaskLifecycleInfo carries details about a task event.
type TaskLifecycleInfo struct {
	TaskID string                 `json:"task_id"`
	Name   string                 `json:"name,omitempty"`
	Status string                 `json:"status,omitempty"`
	Extra  map[string]interface{} `json:"extra,omitempty"`
}

// ElicitationRequestInfo carries details about an elicitation request.
type ElicitationRequestInfo struct {
	RequestID string                 `json:"request_id"`
	Schema    map[string]interface{} `json:"schema,omitempty"`
	URL       string                 `json:"url,omitempty"`
	Mode      string                 `json:"mode"`
}

// ElicitationResultInfo carries details about an elicitation result.
type ElicitationResultInfo struct {
	RequestID string                 `json:"request_id"`
	Response  map[string]interface{} `json:"response,omitempty"`
	Cancelled bool                   `json:"cancelled"`
}

// ModelSelectInfo describes a model selection event.
type ModelSelectInfo struct {
	RequestedModel  string   `json:"requestedModel"`
	AvailableModels []string `json:"availableModels,omitempty"`
}

// TurnInfo describes a turn lifecycle event.
type TurnInfo struct {
	TurnNumber int `json:"turnNumber"`
}

// AgentInfo describes an agent lifecycle event.
type AgentInfo struct {
	Name string `json:"name"`
	Task string `json:"task,omitempty"`
}

// BeforeProviderRequestInfo describes a pending outbound LLM provider request.
// Fired immediately before the engine dispatches a request to the model
// provider from the agent loop. Observe-only: handler return values are
// ignored. Extensions use this hook to log prompts, count tokens, inject
// telemetry tags, or enforce client-side rate limits.
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type BeforeProviderRequestInfo struct {
	// Provider is the provider ID resolved for this request (e.g. "anthropic",
	// "openai", "azure_openai"). Empty if the model could not be resolved to a
	// registered provider (in which case the hook still fires before the loop
	// errors out, so handlers can observe the failed dispatch attempt).
	Provider string `json:"provider"`
	// Model is the model name the request will be sent to. This is the
	// post-fallback model — if the agent loop is on a fallback hop, Model
	// reflects the current hop, not the original request model.
	Model string `json:"model"`
	// TurnNumber is the agent-loop turn that triggered this request (0-based).
	TurnNumber int `json:"turnNumber"`
	// MessageCount is the number of messages in the request payload.
	MessageCount int `json:"messageCount"`
	// ToolCount is the number of tool definitions attached to the request.
	ToolCount int `json:"toolCount"`
	// HasSystemPrompt is true when the request carries a non-empty system prompt.
	HasSystemPrompt bool `json:"hasSystemPrompt"`
	// MaxTokens is the configured response cap (0 = provider default).
	MaxTokens int `json:"maxTokens,omitempty"`
}

// BeforeAgentStartResult holds the optional overrides a before_agent_start handler may return.
type BeforeAgentStartResult struct {
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

// BeforePromptResult holds the optional overrides a before_prompt handler may return.
type BeforePromptResult struct {
	Prompt       string `json:"prompt,omitempty"`       // rewritten user prompt; empty means no change
	SystemPrompt string `json:"systemPrompt,omitempty"` // appended to system prompt; empty means no change
}

// PlanModePromptResult holds the optional overrides a plan_mode_prompt handler may return.
type PlanModePromptResult struct {
	Prompt        string   `json:"prompt,omitempty"`        // custom plan mode prompt; empty means use default
	Tools         []string `json:"tools,omitempty"`         // custom allowed tools; nil means use default
	SparseReminder string  `json:"sparseReminder,omitempty"` // custom sparse reminder text; empty means use default
}

// SystemInjectInfo is the payload for the system_inject hook.
type SystemInjectInfo struct {
	Kind        string `json:"kind"`        // "plan_mode_reminder", "turn_limit_warning", "max_token_continue"
	DefaultText string `json:"defaultText"` // engine's default injection text
	Turn        int    `json:"turn"`        // current turn number
	MaxTurns    int    `json:"maxTurns"`    // configured max turns (0 = unlimited)
}

// SystemInjectResult holds the optional overrides a system_inject handler may return.
type SystemInjectResult struct {
	Text     string `json:"text,omitempty"`     // replacement text; empty means use default
	Suppress bool   `json:"suppress,omitempty"` // true = do not inject this message
}

// ExtensionRespawnedInfo carries the payload for the extension_respawned hook.
type ExtensionRespawnedInfo struct {
	AttemptNumber int    `json:"attemptNumber"`
	PrevExitCode  *int   `json:"prevExitCode,omitempty"`
	PrevSignal    string `json:"prevSignal,omitempty"`
}

// TurnAbortedInfo carries the payload for the turn_aborted hook.
type TurnAbortedInfo struct {
	Reason string `json:"reason"`
}

// PeerExtensionInfo carries the payload for peer_extension_died /
// peer_extension_respawned hooks. Reports the sibling that changed state.
type PeerExtensionInfo struct {
	Name          string `json:"name"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	Signal        string `json:"signal,omitempty"`
	AttemptNumber int    `json:"attemptNumber,omitempty"`
}

// EarlyStopDecisionInfo describes a pending early-stop continuation decision.
// Fires after the model emits end_turn / stop and after the engine has updated
// its cumulative output-token counter, but **before** it evaluates the
// continuation criteria. The hook is the primary extension point for harness
// engineers writing continuation policy: handlers can force the verdict,
// override the budget mid-run, or supply a custom continuation prompt.
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type EarlyStopDecisionInfo struct {
	// RunID is the engine-issued request ID for this run.
	RunID string `json:"runId"`
	// Model is the model identifier that just stopped.
	Model string `json:"model"`
	// TurnNumber is the turn that ended (1-based, matches turn_start).
	TurnNumber int `json:"turnNumber"`
	// StopReason is the provider-reported stop reason that triggered this
	// decision ("end_turn" or "stop"). Always non-empty.
	StopReason string `json:"stopReason"`
	// CumulativeOutputTokens is the running total of output tokens across
	// every turn of this run (including the turn that just ended).
	CumulativeOutputTokens int `json:"cumulativeOutputTokens"`
	// Budget is the effective output-token budget for this run after
	// engine-config + RunOptions merging (before any handler override).
	Budget int `json:"budget"`
	// ThresholdPct is the effective completion-threshold percent.
	ThresholdPct int `json:"thresholdPct"`
	// ContinuationCount is the number of times the engine has already
	// nudged the model on this run (0 before the first nudge).
	ContinuationCount int `json:"continuationCount"`
	// MaxContinuations is the configured cap.
	MaxContinuations int `json:"maxContinuations"`
	// LastContinuationDelta is the output-token delta from the previous
	// continuation (0 on the first decision). Used by the diminishing-
	// returns guard.
	LastContinuationDelta int `json:"lastContinuationDelta"`
	// WouldContinue is the engine's tentative verdict before this hook
	// runs. Handlers may flip it via EarlyStopDecisionResult.ForceContinue.
	WouldContinue bool `json:"wouldContinue"`
	// IsSubagent is true when this run is a child agent dispatched by the
	// Agent tool. The engine defaults the feature off for subagents; the
	// hook still fires so harness can force-on with ForceContinue=&true.
	IsSubagent bool `json:"isSubagent,omitempty"`
}

// EarlyStopDecisionResult is the optional return value from a
// before_early_stop_decision handler. Any combination of fields may be set;
// nil pointers and zero values mean "defer to the engine's decision".
// The last non-nil result across hosts wins for each individual field
// (matches the FireBeforePrompt resolution pattern).
type EarlyStopDecisionResult struct {
	// ForceContinue overrides the engine's verdict. &true forces a
	// continuation (even if WouldContinue=false); &false forces a stop
	// (even if WouldContinue=true). nil defers to engine logic.
	ForceContinue *bool `json:"forceContinue,omitempty"`
	// OverrideBudget bumps (or shrinks) the effective output-token budget
	// for the remainder of the run. Zero means "no override". Useful when
	// scope expands mid-run (e.g. user just added requirements).
	OverrideBudget int `json:"overrideBudget,omitempty"`
	// OverrideThresholdPct adjusts the completion threshold for the
	// remainder of the run. Zero means "no override".
	OverrideThresholdPct int `json:"overrideThresholdPct,omitempty"`
	// ContinueMessage replaces the default continuation prompt text. Empty
	// means "use the engine's default phrasing".
	ContinueMessage string `json:"continueMessage,omitempty"`
}

// PlanModeEnterInfo is the payload for the before_plan_mode_enter hook.
// Fired when the LLM calls the EnterPlanMode tool (or any future mechanism
// that requests a model-initiated transition into plan mode). Handlers can
// return BeforePlanModeEnterResult to deny the transition. Default is allow.
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type PlanModeEnterInfo struct {
	// Source identifies what triggered the request. "model_tool" when the LLM
	// called the EnterPlanMode sentinel tool directly.
	Source string `json:"source"`
}

// BeforePlanModeEnterResult is the optional return value from a
// before_plan_mode_enter handler. A nil Allow (pointer not set) means
// "no opinion — use the default (allow)". Only an explicit &false denies.
// The last non-nil Allow across all hosts wins (last-writer semantics).
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type BeforePlanModeEnterResult struct {
	// Allow controls whether plan mode entry is permitted. nil = defer to
	// engine default (allow). &true = explicitly allow. &false = deny.
	Allow *bool `json:"allow,omitempty"`
	// Reason is an optional human-readable explanation returned to the LLM
	// in the tool result when Allow is &false.
	Reason string `json:"reason,omitempty"`
}

// BeforePlanModeExitInfo is the payload for the before_plan_mode_exit hook.
// Fired when the LLM calls the ExitPlanMode sentinel tool, before the run is
// terminated and the plan-ready card is surfaced to the user. Handlers may
// return BeforePlanModeExitResult to veto the exit (e.g. to send the model
// back for more planning) or to allow it.
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type BeforePlanModeExitInfo struct {
	// PlanFilePath is the path of the plan file being submitted for review.
	PlanFilePath string `json:"planFilePath"`
	// Source is always "model_tool" for now (future: "extension").
	Source string `json:"source"`
}

// BeforePlanModeExitResult is the optional return value from a
// before_plan_mode_exit handler. nil Allow (pointer not set) means
// "no opinion — use the default (allow)". Last non-nil Allow wins.
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type BeforePlanModeExitResult struct {
	// Allow controls whether the plan mode exit proceeds. nil = defer to
	// default (allow). &false = deny (keep the model in plan mode).
	Allow *bool `json:"allow,omitempty"`
	// Reason is returned to the LLM in the tool result when Allow is &false,
	// explaining why the exit was denied and what it should do instead.
	Reason string `json:"reason,omitempty"`
}

// EarlyStopContinuedInfo describes a continuation that was just injected
// into the conversation. Fires after the engine has decided to continue,
// the message has been written, and the loop is about to start a new turn.
// Observe-only — return values are ignored.
//
// Field stability: this struct is part of the published hook contract. New
// fields may be added with zero-value defaults; existing fields must not be
// removed or renamed.
type EarlyStopContinuedInfo struct {
	// RunID is the engine-issued request ID for this run.
	RunID string `json:"runId"`
	// TurnNumber is the turn that just ended (the new turn has not started yet).
	TurnNumber int `json:"turnNumber"`
	// ContinuationCount is the new count after this nudge (1-based).
	ContinuationCount int `json:"continuationCount"`
	// Pct is the percent-of-budget the model reached before stopping.
	Pct int `json:"pct"`
	// CumulativeOutputTokens is the running total across the run.
	CumulativeOutputTokens int `json:"cumulativeOutputTokens"`
	// Budget is the effective budget at the moment of injection (after
	// any OverrideBudget from a before_early_stop_decision handler).
	Budget int `json:"budget"`
	// InjectedText is the final continuation prompt text that landed in
	// the conversation (after OnSystemInject rewrites). Empty when the
	// downstream OnSystemInject hook suppressed the injection.
	InjectedText string `json:"injectedText"`
}
