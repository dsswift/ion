package extension

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// Dispatch-related SDK types, split from sdk_types.go to stay under the
// 800-line file-size cap. Same package; no API change.

// DispatchAgentOpts configures an engine-native agent dispatch.
type DispatchAgentOpts struct {
	Name         string `json:"name"`
	Task         string `json:"task"`
	Model        string `json:"model,omitempty"`
	ExtensionDir string `json:"extensionDir,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	ProjectPath  string `json:"projectPath,omitempty"`
	SessionID    string `json:"sessionId,omitempty"`

	// MaxTurns caps the child session's agent loop iteration count. <=0 (the
	// default when omitted) means unlimited -- the engine ships unopinionated.
	// Lets harness engineers fine-tune dispatched-agent budgets without
	// touching global engine config.
	MaxTurns int `json:"maxTurns,omitempty"`

	// MaxDispatchDepth overrides the engine-config MaxDispatchDepth for this
	// single dispatch tree. When >0, the child (and its descendants) use this
	// cap instead of the global config value. <=0 means "use the global
	// config default." Allows an extension to grant a specific dispatch tree
	// more (or fewer) nesting levels without changing the engine-wide cap.
	MaxDispatchDepth int `json:"maxDispatchDepth,omitempty"`

	// --- Plan mode ---

	// PlanMode, when true, starts the child session in plan mode. The child
	// receives a plan-mode-filtered tool set, the plan-mode system prompt,
	// and the ExitPlanMode sentinel tool. When the child calls ExitPlanMode,
	// the run terminates with the plan file path in the result.
	PlanMode bool `json:"planMode,omitempty"`

	// PlanFilePath overrides the plan file path for the child session. When
	// empty and PlanMode is true, the engine allocates a fresh plan file
	// with a word-slug name (the default behavior for any plan-mode session).
	PlanFilePath string `json:"planFilePath,omitempty"`

	// PlanModeTools overrides the set of allowed tools during plan mode for
	// the child session. When nil/empty and PlanMode is true, the engine
	// uses the default plan-mode tool set.
	PlanModeTools []string `json:"planModeTools,omitempty"`

	// AllowedTools restricts the child session's tool set for the entire
	// dispatch (not just plan mode). When non-empty, the child runs with
	// exactly this allowlist; when nil/empty the child inherits the engine's
	// default tool set (no restriction). This lets a caller scope a
	// dispatched agent to a narrow remit -- e.g. the orchestrator's Agent
	// tool passes a matched agent spec's Tools through here so a specialist
	// only sees the tools its spec declares. Distinct from PlanModeTools,
	// which applies only while the child is in plan mode.
	AllowedTools []string `json:"allowedTools,omitempty"`

	// AllowedSubAgents is the set of agent names this dispatch's agent is
	// permitted to dispatch in turn. The engine enforces it as an allowlist:
	// when non-empty, a nested dispatch whose name is not a member is rejected
	// with ErrSubAgentNotAllowed. When nil/empty the allowlist layer is inert
	// (no restriction) -- but the engine's self-dispatch rail still applies
	// regardless. The harness owns this opinion: it knows its agent graph
	// (e.g. a lead's parent-derived children) and passes the permitted set per
	// dispatch. The engine has no opinion on agent tiers or naming; it only
	// enforces membership. Additive and non-breaking: callers that don't set
	// it get the prior behavior (self-rail only).
	AllowedSubAgents []string `json:"allowedSubAgents,omitempty"`

	// ImplementationPhase marks this dispatch as the "implement" half of a
	// plan-then-implement flow: the plan is already approved and the child
	// must execute it directly. When true, the engine skips injecting the
	// EnterPlanMode sentinel tool into the child run, so the child can never
	// stall by proposing plan mode mid-implementation. Mirrors
	// RunOptions.ImplementationPhase (which root prompts already carry) onto
	// the dispatch path -- previously unreachable from ctx.dispatchAgent,
	// which forced harnesses to fight plan-mode stalls with prompt text
	// ("Do NOT call EnterPlanMode"), the exact brittle mechanism the
	// RunOptions field was added to replace. Additive and non-breaking.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`

	// SuppressTools removes the named tools from the child session's tool
	// set. Unlike AllowedTools (a whitelist replacing the default set), this
	// is a targeted blacklist layered on top of whatever set the child would
	// otherwise get. Mirrors RunOptions.SuppressTools onto the dispatch path
	// so a harness can, e.g., suppress the engine's built-in Agent tool in
	// children whose delegation must route through the harness's own
	// dispatch tool. Additive and non-breaking.
	SuppressTools []string `json:"suppressTools,omitempty"`

	// ContextPolicy is the per-dispatch context-layer override (level 4 of the
	// four-level cascade). When nil, the session default (level 3) or engine.json
	// (level 2) or built-in default (level 1, all on) applies. Tri-state fields:
	// nil = inherit.
	ContextPolicy *ContextPolicy `json:"contextPolicy,omitempty"`

	// FallbackChain is an ordered list of alternative model IDs the child
	// run's retry loop walks when the primary model is overloaded. Typically
	// the tail of a resolved tier chain (e.g. resolving a "standard" tier
	// alias yields a concrete model plus its declared fallbacks). When empty,
	// the child has no explicit fallback list and relies only on the engine's
	// DefaultModel threading for the unresolvable-model case. Additive and
	// non-breaking: callers that don't set it get the prior behavior.
	FallbackChain []string `json:"fallbackChain,omitempty"`

	// DisplayName overrides the human-readable label shown on the dispatched
	// agent's pill. When empty, the engine resolves a display name from the
	// matched agent spec's Description, then the extension roster, then falls
	// back to the agent name. The orchestrator's Agent tool sets this to the
	// call-site description (or a prompt-derived label) so the LLM's intent
	// for the pill label is honored. Additive and non-breaking.
	DisplayName string `json:"displayName,omitempty"`

	// ParentCtx, when non-nil, is the cancellation context the dispatch's
	// in-process wait derives from instead of the session cancellation root.
	// The orchestrator's Agent tool passes the per-tool-call context here so
	// cancelling that call (run abort, tool deadline) cancels the foreground
	// dispatch and returns promptly. Because the tool-call context is itself
	// derived from the session, a session-level abort still cascades. When
	// nil the dispatch falls back to the session root (the prior behavior for
	// extension-initiated dispatches). Not serialized -- in-process only.
	ParentCtx context.Context `json:"-"`

	// OnEvent is called for each engine event emitted by the child session.
	// Not serialized -- set via the host when dispatching from an extension.
	OnEvent func(ev types.EngineEvent) `json:"-"`

	// --- Background dispatch (Phase 1) ---

	// Background, when true, causes the dispatch to return a stub result
	// immediately and run the child session in a goroutine. The terminal
	// outcome is delivered via OnComplete, OnError, or OnRecall.
	Background bool `json:"background,omitempty"`

	// OnComplete fires when a background dispatch finishes successfully
	// (exit code 0). Not called for foreground dispatches.
	OnComplete func(result DispatchAgentResult) `json:"-"`

	// OnError fires when a background dispatch finishes with an error
	// (non-zero exit code or child error). Not called for foreground dispatches.
	OnError func(err DispatchError) `json:"-"`

	// OnRecall fires when a background dispatch is cancelled via RecallAgent.
	// Not called for foreground dispatches.
	OnRecall func(info RecallInfo) `json:"-"`

	// --- Lifecycle event callbacks (Phase 2) ---

	// OnToolStart fires when the dispatched agent begins a tool invocation.
	OnToolStart func(info DispatchToolStartInfo) `json:"-"`

	// OnToolEnd fires when a dispatched agent's tool invocation completes
	// successfully (IsError=false on the ToolResultEvent).
	OnToolEnd func(info DispatchToolEndInfo) `json:"-"`

	// OnToolError fires when a dispatched agent's tool invocation completes
	// with an error (IsError=true on the ToolResultEvent).
	OnToolError func(info DispatchToolErrorInfo) `json:"-"`

	// OnUsage fires when the dispatched agent emits a usage event, carrying
	// both the per-turn usage and cumulative totals across the dispatch.
	OnUsage func(info DispatchUsageInfo) `json:"-"`

	// OnTextDelta fires when the dispatched agent emits a text chunk,
	// carrying the delta and accumulated text so far.
	OnTextDelta func(info DispatchTextDeltaInfo) `json:"-"`

	// --- Plan mode lifecycle callbacks ---

	// OnPlanProposal fires when a dispatched agent calls ExitPlanMode,
	// proposing a plan for approval. This callback is observational — the
	// plan proposal event is always forwarded to the parent session via
	// OnEvent regardless of whether this callback is set. Use it to react
	// to proposals (e.g. log, notify, update state) without suppressing them.
	OnPlanProposal func(info DispatchPlanProposalInfo) `json:"-"`

	// OnChildQuestion fires when a dispatched child calls AskUserQuestion.
	// The dispatcher receives the question and must either answer it (by
	// returning a non-empty answer string) or escalate it (by returning
	// an escalation marker that the harness interprets as "ask my parent").
	// When this callback is nil, the child's AskUserQuestion falls through
	// to the standard terminate-the-run path. When set, the child blocks
	// until the callback returns or the session is torn down.
	//
	// The callback is called in a goroutine so it may block. It must
	// return within the session's lifetime. Return (answer, false, nil) to
	// answer and resume the child; (_, true, nil) to cancel the child's
	// question (run terminates); (_, _, err) on error (run terminates).
	OnChildQuestion func(info DispatchChildQuestionInfo) (answer string, cancelled bool, err error) `json:"-"`
}

// DispatchAgentResult holds the outcome of a dispatched agent.
type DispatchAgentResult struct {
	Name         string  `json:"name"`
	Output       string  `json:"output"`
	ExitCode     int     `json:"exitCode"`
	Elapsed      float64 `json:"elapsed"`
	Cost         float64 `json:"cost"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`

	// DispatchID is the engine-assigned unique identifier for this dispatch
	// instance. Collision-safe: two parallel dispatches of the same agent
	// name in the same millisecond receive distinct IDs. Consumers use it
	// to target a specific dispatch for recall, follow-up, or metrics
	// correlation. Matches the "id" field in the agent state dispatches[]
	// metadata array. Populated on both foreground results and background
	// stubs (the stub carries the ID so callers can reference the dispatch
	// before it completes).
	DispatchID string `json:"dispatchId,omitempty"`
	// ThinkingTokens is the estimated reasoning-token count for the dispatch
	// (issue #158), a subset of OutputTokens that providers fold into the
	// output usage. Estimated from accumulated reasoning text — see
	// ThinkingBlockEndEvent.TotalTokens for the estimate caveat. Lets
	// cost/audit consumers separate reasoning spend from user-facing output.
	// Zero when the model produced no extended thinking.
	ThinkingTokens           int    `json:"thinkingTokens,omitempty"`
	CacheReadInputTokens     int    `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int    `json:"cacheCreationInputTokens,omitempty"`
	SessionID                string `json:"sessionId,omitempty"`

	// PlanFilePath is the absolute path of the plan file written by the
	// child session. Non-empty only when the child was in plan mode and
	// wrote a plan (regardless of whether it called ExitPlanMode).
	PlanFilePath string `json:"planFilePath,omitempty"`

	// PlanExited is true when the child called ExitPlanMode (the run
	// terminated because the model proposed a plan for approval). When
	// false and PlanFilePath is non-empty, the child was in plan mode but
	// finished without proposing (e.g. hit max turns or was recalled).
	PlanExited bool `json:"planExited,omitempty"`

	// Depth is the dispatch depth of this agent in the dispatch tree.
	// The orchestrator (root) runs at depth 0; its direct dispatches are
	// depth 1; their dispatches are depth 2; etc. Set by the engine,
	// not by the caller.
	Depth int `json:"depth,omitempty"`

	// ParentDispatchId is the DispatchID of the parent dispatch that
	// spawned this agent. Empty for top-level dispatches (depth 1,
	// parent is the orchestrator at depth 0). Populated by the engine
	// so consumers can reconstruct the dispatch tree.
	ParentDispatchId string `json:"parentDispatchId,omitempty"`
}

// DispatchError describes a failed background dispatch.
type DispatchError struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Message    string  `json:"message"`
	ExitCode   int     `json:"exitCode"`
	Elapsed    float64 `json:"elapsed"`
}

// RecallInfo describes a recalled (cancelled) background dispatch.
type RecallInfo struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Reason     string  `json:"reason"`
	Elapsed    float64 `json:"elapsed"`
	ToolCount  int     `json:"toolCount"`
}

// RecallAgentOpts configures a recall operation.
type RecallAgentOpts struct {
	Reason string `json:"reason,omitempty"`
}

// ContextPolicy configures which context layers a dispatched agent receives.
// All fields are tri-state (pointer bools): nil = inherit from the level above.
// Resolution order: per-dispatch > session default > engine.json > built-in (all on).
type ContextPolicy struct {
	// IncludeGlobalContext controls whether home roots (~/.ion, ~/.claude under
	// compat) are included. Nil inherits from the enclosing level.
	IncludeGlobalContext *bool `json:"includeGlobalContext,omitempty"`
	// IncludeProjectContext controls whether the child's cwd + ancestor walk is
	// performed. Nil inherits from the enclosing level.
	IncludeProjectContext *bool `json:"includeProjectContext,omitempty"`
	// ClaudeCompat overrides the engine's ClaudeCompat setting for this walk.
	// Nil means inherit from engine config.
	ClaudeCompat *bool `json:"claudeCompat,omitempty"`
}

// SteerDispatchResult is the typed outcome of a SteerDispatch call.
// Delivered is true when the message was buffered on the child's steer
// channel. Outcome carries the four-value verdict string so the caller
// can react precisely (retry on channel_full, redispatch on no_run, etc.).
type SteerDispatchResult struct {
	Delivered bool   `json:"delivered"`
	Outcome   string `json:"outcome"`
}

// --- Phase 2: Lifecycle event callback payloads ---

// DispatchToolStartInfo carries data for the OnToolStart callback.
type DispatchToolStartInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
}

// DispatchToolEndInfo carries data for the OnToolEnd callback.
type DispatchToolEndInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchToolErrorInfo carries data for the OnToolError callback.
type DispatchToolErrorInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchUsageInfo carries per-turn and cumulative usage data.
type DispatchUsageInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`

	// Per-turn usage from the current UsageEvent.
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`

	// Cumulative totals across all turns in this dispatch.
	CumulativeInputTokens  int     `json:"cumulativeInputTokens"`
	CumulativeOutputTokens int     `json:"cumulativeOutputTokens"`
	CumulativeCost         float64 `json:"cumulativeCost"`
}

// DispatchTextDeltaInfo carries a text chunk and accumulated text.
type DispatchTextDeltaInfo struct {
	Name        string `json:"name"`
	DispatchID  string `json:"dispatchId,omitempty"`
	Delta       string `json:"delta"`
	Accumulated string `json:"accumulated"`
}

// DispatchPlanProposalInfo carries data for the OnPlanProposal callback.
type DispatchPlanProposalInfo struct {
	Name         string `json:"name"`
	AgentID      string `json:"agentId"`
	PlanFilePath string `json:"planFilePath"`
	PlanSlug     string `json:"planSlug"`
	// PlanRequested is true when the caller explicitly set PlanMode=true
	// on the dispatch opts. False when the child agent self-initiated
	// plan mode (called EnterPlanMode without being told to).
	PlanRequested bool `json:"planRequested"`
}

// DispatchChildQuestionInfo carries the question raised by a dispatched child
// via AskUserQuestion. Surfaced to the dispatcher via OnChildQuestion.
type DispatchChildQuestionInfo struct {
	// Name is the dispatched agent's name.
	Name string `json:"name"`
	// DispatchID is the dispatch's unique identifier.
	DispatchID string `json:"dispatchId"`
	// Question is the text from the child's AskUserQuestion call.
	Question string `json:"question"`
	// Depth is the dispatch nesting depth of the child (1 = direct child of orchestrator).
	Depth int `json:"depth"`
}
