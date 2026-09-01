// context_dispatch.go — agent dispatch, recall, steering, and the context
// policy surface.
//
// Dispatch delegates work to a child agent session. It runs asynchronously by
// default; set WaitForCompletion for foreground terminal output.
//
// Notification routing is keyed by dispatch id first and agent name second.
// Two parallel dispatches of the same agent share a name but not an id, so an
// id-keyed handler is the only way each gets its own terminal callback.
package ion

// ContextPolicy controls which context files a dispatched child inherits.
// Each field is a pointer so nil means "inherit the session default", distinct
// from an explicit false.
type ContextPolicy struct {
	IncludeGlobalContext  *bool `json:"includeGlobalContext,omitempty"`
	IncludeProjectContext *bool `json:"includeProjectContext,omitempty"`
	ClaudeCompat          *bool `json:"claudeCompat,omitempty"`
	// MaxContextBytes caps total injected context-file bytes for this dispatch.
	// Zero or negative means no cap. Files are included whole, nearest-first,
	// until the budget is spent; the rest are skipped and logged by name. A
	// file is never truncated mid-content.
	//
	// Context injection repeats full file content on every dispatch, so a large
	// global instruction file is a recurring per-dispatch cost paid before the
	// task text. Set this on fan-out dispatches whose children only need their
	// own repo's guidance.
	MaxContextBytes int `json:"maxContextBytes,omitempty"`
}

// DispatchAgentOpts configures a dispatch.
type DispatchAgentOpts struct {
	// Name is the agent to dispatch. Required.
	Name string `json:"name"`
	// Task is what the agent should do. Required.
	Task string `json:"task"`
	// Model overrides the session's model for the child.
	Model string `json:"model,omitempty"`
	// ExtensionDir loads an extension into the child session, giving it the
	// extension's hooks, persona, and tools — including this extension's own
	// dispatch tool, which is what makes n-tier delegation work. Accepts a
	// directory or a direct entry-point path. Pass ctx.Config.ExtensionDir to
	// give the child the same extension as the dispatcher.
	ExtensionDir string `json:"extensionDir,omitempty"`
	// SystemPrompt is the child's persona.
	SystemPrompt string `json:"systemPrompt,omitempty"`
	// ProjectPath overrides the child's working directory.
	ProjectPath string `json:"projectPath,omitempty"`
	// SessionID resumes an existing child session.
	SessionID string `json:"sessionId,omitempty"`
	// ClientDispatchID registers your OWN identifier for this dispatch as an
	// alias for the engine's dispatch ID, so a later SteerDispatch or
	// RecallDispatch addressed with your key reaches this dispatch.
	//
	// Set it when your bookkeeping is keyed before the dispatch returns. A
	// harness typically has to name a dispatch first: it records local state
	// the moment it decides to dispatch, keys that state by an id it minted
	// itself, and only then receives the engine's DispatchID. Steering with the
	// local key misses — and the miss is reported as "not_found", the same
	// answer as a dispatch that already finished, so nothing signals that the
	// address was wrong and every steer for that dispatch is silently dropped.
	//
	// Optional. Omit it and nothing is aliased; prefer the returned DispatchID
	// where you can. The alias is dropped when the dispatch ends, so a reused
	// key never resolves to a stale dispatch.
	ClientDispatchID string `json:"clientDispatchId,omitempty"`
	// MaxConcurrentPerName caps how many dispatches of THIS agent name may be
	// live at once under the same parent. Zero or negative (including omitted)
	// means no cap.
	//
	// The engine owns the mechanism and you own the number: only the engine's
	// registry knows what is actually live, but which agents are singletons is
	// your policy. Set it to 1 for an agent that owns exclusive durable state,
	// or whose value comes from reasoning over everything at once rather than
	// one item at a time. Leave it unset for an agent doing an isolated job
	// that parallelises cleanly.
	//
	// Scoped per PARENT, not per session. A cap of 1 means "this dispatcher may
	// hold one at a time" — so two different parents may each hold their own
	// dispatch of the same cross-cutting advisory agent concurrently, while a
	// state-owning agent still cannot be doubled under one parent.
	//
	// A refusal returns ErrConcurrencyCapReached and names the dispatch ids
	// already holding the slot, so the caller can wait for, steer, or read the
	// result of the running dispatch instead of retrying blindly.
	MaxConcurrentPerName int `json:"maxConcurrentPerName,omitempty"`
	// MaxTurns caps the child's agent loop. Zero or negative means the
	// engine default.
	MaxTurns int `json:"maxTurns,omitempty"`
	// MaxDispatchDepth caps how deep the child may itself dispatch.
	MaxDispatchDepth int `json:"maxDispatchDepth,omitempty"`
	// CallbackID is an opaque token the engine echoes on every lifecycle and
	// terminal notification for this dispatch. This SDK routes notifications by
	// agent name and then by dispatch id (see context_dispatch_routing.go), so
	// it does not need one; the field exists so a caller that consumes the raw
	// notification stream itself can correlate the pre-stub window, and so the
	// serialised request shape matches the other SDKs.
	CallbackID string `json:"callbackId,omitempty"`
	// PlanMode starts the child in plan mode.
	PlanMode bool `json:"planMode,omitempty"`
	// PlanFilePath is where the child writes its plan.
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanModeTools overrides the tools available in the child's plan mode.
	PlanModeTools []string `json:"planModeTools,omitempty"`
	// AllowedTools restricts the child's tool set.
	AllowedTools []string `json:"allowedTools,omitempty"`
	// AllowedSubAgents restricts which agents the child may dispatch.
	AllowedSubAgents []string `json:"allowedSubAgents,omitempty"`
	// SubAgentPolicy decides what an empty AllowedSubAgents means:
	// "allowlist" makes it a hard restriction (an empty list means the child
	// may dispatch NOTHING), "unrestricted" (the engine default) leaves an
	// empty list meaning no restriction at all. A harness that fans out
	// through leaf agents sets "allowlist", because the default lets a leaf
	// agent dispatch anything — including re-dispatching its own lead into
	// the depth cap.
	SubAgentPolicy string `json:"subAgentPolicy,omitempty"`
	// ImplementationPhase marks the child as executing an approved plan.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`
	// RequireToolUse declares whether this dispatch must produce work — that
	// is, call at least one tool. Tri-state:
	//
	//   nil   — no expectation declared. The engine reports ToolCount on the
	//           result and passes no judgement. The zero value, so existing
	//           callers keep today's behavior exactly.
	//   true  — a completion with zero tool calls is not success. The engine
	//           gives the child ONE continuation naming the expectation; if the
	//           retry also calls nothing the dispatch reports exit code 3 with
	//           delivered status "declined".
	//   false — explicitly exempt. Analysis and advisory dispatches
	//           legitimately produce text and call nothing.
	//
	// Declare it on execution dispatches and leave it unset on planning,
	// review, and summarization dispatches. The engine never infers the
	// expectation from task text: only the caller knows which kind of
	// dispatch it issued.
	RequireToolUse *bool `json:"requireToolUse,omitempty"`
	// SuppressTools removes tools from the child's set.
	SuppressTools []string `json:"suppressTools,omitempty"`
	// ContextPolicy overrides which context files the child inherits.
	ContextPolicy *ContextPolicy `json:"contextPolicy,omitempty"`
	// FallbackChain is the child's model fallback order.
	FallbackChain []string `json:"fallbackChain,omitempty"`
	// DisplayName is the label clients show for this dispatch.
	DisplayName string `json:"displayName,omitempty"`
	// WaitForCompletion is the explicit foreground opt-in. When false,
	// including when omitted, dispatch returns a stub immediately and terminal
	// callbacks observe completion asynchronously.
	WaitForCompletion bool `json:"waitForCompletion,omitempty"`
	// Background remains accepted for compatibility with older engine versions.
	// It no longer selects execution mode; use WaitForCompletion for foreground
	// dispatch.
	// Deprecated: use WaitForCompletion.
	Background bool `json:"background,omitempty"`
	// Detached excludes an asynchronous child from the parent run's parked-child
	// set. Use it for genuine fire-and-forget work.
	Detached bool `json:"detached,omitempty"`

	// --- Callbacks. Local only; never serialised. ---

	// OnComplete fires when an asynchronous dispatch finishes successfully.
	OnComplete func(DispatchAgentResult) `json:"-"`
	// OnError fires when an asynchronous dispatch fails.
	OnError func(DispatchError) `json:"-"`
	// OnRecall fires when an asynchronous dispatch is cancelled by
	// [Context.RecallDispatch].
	OnRecall func(RecallInfo) `json:"-"`
	// OnEvent receives the child's raw engine events.
	OnEvent func(EngineEvent) `json:"-"`
	// OnToolStart fires as the child begins a tool call.
	OnToolStart func(DispatchToolStartInfo) `json:"-"`
	// OnToolEnd fires when the child's tool call succeeds.
	OnToolEnd func(DispatchToolEndInfo) `json:"-"`
	// OnToolError fires when the child's tool call fails.
	OnToolError func(DispatchToolErrorInfo) `json:"-"`
	// OnUsage fires with per-turn and cumulative token usage.
	OnUsage func(DispatchUsageInfo) `json:"-"`
	// OnTextDelta fires with the child's streaming text.
	OnTextDelta func(DispatchTextDeltaInfo) `json:"-"`
	// OnPlanProposal fires when the child proposes a plan.
	OnPlanProposal func(DispatchPlanProposalInfo) `json:"-"`
	// OnChildQuestion fires when the child asks the operator a question. The
	// child's run blocks until this returns, so answer promptly.
	OnChildQuestion func(DispatchChildQuestionInfo) (answer string, cancelled bool, err error) `json:"-"`
}

// DispatchAgentResult is a dispatch's outcome. For an asynchronous dispatch the
// immediate return is a stub carrying DispatchID; the real result arrives via
// OnComplete.
type DispatchAgentResult struct {
	Name         string  `json:"name"`
	Output       string  `json:"output"`
	ExitCode     int     `json:"exitCode"`
	Elapsed      float64 `json:"elapsed"`
	Cost         float64 `json:"cost"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	// ToolCount is how many tool calls the child made across its whole run.
	// Reported unconditionally, whether or not RequireToolUse was declared: it
	// is an observed fact about the run, not a verdict about it.
	//
	// A zero here on an ExitCode:0 dispatch is the signature of a child that
	// answered instead of working — it read the task, described the work, and
	// ended its turn. Prefer this over reconstructing a count from your own
	// lifecycle-callback bookkeeping; this is the engine's own count.
	ToolCount int `json:"toolCount"`
	// CallbackID is echoed from the request. Empty unless the caller supplied
	// one; this SDK's own routing does not use it.
	CallbackID string `json:"callbackId,omitempty"`
	// DepthCapExceeded is true when the engine refused to launch the child
	// because it would meet or exceed the dispatch-depth cap. The refusal
	// resolves normally rather than erroring, so check this before treating a
	// zero-valued result as a launched child.
	DepthCapExceeded bool `json:"depthCapExceeded,omitempty"`
	// RemainingDepthBudget is the number of child levels still available from
	// the caller under the effective depth cap. Zero means this agent may run
	// but cannot create another child.
	RemainingDepthBudget int `json:"remainingDepthBudget"`
	// DispatchID identifies this dispatch instance. Use it to steer or recall
	// when several dispatches share an agent name.
	DispatchID               string `json:"dispatchId,omitempty"`
	ThinkingTokens           int    `json:"thinkingTokens,omitempty"`
	CacheReadInputTokens     int    `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int    `json:"cacheCreationInputTokens,omitempty"`
	SessionID                string `json:"sessionId,omitempty"`
	PlanFilePath             string `json:"planFilePath,omitempty"`
	PlanExited               bool   `json:"planExited,omitempty"`
	Depth                    int    `json:"depth,omitempty"`
	ParentDispatchID         string `json:"parentDispatchId,omitempty"`
}

// DispatchError is a failed asynchronous dispatch.
type DispatchError struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Message    string  `json:"message"`
	ExitCode   int     `json:"exitCode"`
	Elapsed    float64 `json:"elapsed"`
}

// RecallInfo describes a cancelled asynchronous dispatch.
type RecallInfo struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Reason     string  `json:"reason"`
	Elapsed    float64 `json:"elapsed"`
	ToolCount  int     `json:"toolCount"`
}

// SteerDispatchResult reports whether a steer message reached its target.
// Outcome is "steered" (delivered mid-run), "sent" (the target was idle and
// received a fresh prompt), or "not_found".
type SteerDispatchResult struct {
	Delivered bool   `json:"delivered"`
	Outcome   string `json:"outcome"`
}

// DispatchStateEntry is one in-flight dispatch from [Context.ListDispatchState].
type DispatchStateEntry struct {
	DispatchID          string             `json:"dispatchId"`
	Name                string             `json:"name"`
	Status              string             `json:"status"`
	ParentDispatchID    string             `json:"parentDispatchId,omitempty"`
	Depth               int                `json:"depth"`
	StartedAt           string             `json:"startedAt"`
	ElapsedMs           int64              `json:"elapsedMs"`
	ToolCount           int                `json:"toolCount"`
	LastWork            string             `json:"lastWork,omitempty"`
	LastActivityMs      int64              `json:"lastActivityMs"`
	ChildConversationID string             `json:"childConversationId,omitempty"`
	PendingChildren     []string           `json:"pendingChildren,omitempty"`
	WaitingOn           *DispatchWaitingOn `json:"waitingOn,omitempty"`
}

// DispatchWaitingOn identifies work holding a suspended dispatch parked.
type DispatchWaitingOn struct {
	TaskIDs          []string `json:"taskIds,omitempty"`
	ChildDispatchIDs []string `json:"childDispatchIds,omitempty"`
}

// DispatchToolStartInfo reports a child beginning a tool call.
type DispatchToolStartInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
}

// DispatchToolEndInfo reports a child's successful tool call.
type DispatchToolEndInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchToolErrorInfo reports a child's failed tool call.
type DispatchToolErrorInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchUsageInfo reports a child's token usage.
type DispatchUsageInfo struct {
	Name                   string  `json:"name"`
	DispatchID             string  `json:"dispatchId,omitempty"`
	InputTokens            int     `json:"inputTokens"`
	OutputTokens           int     `json:"outputTokens"`
	CumulativeInputTokens  int     `json:"cumulativeInputTokens"`
	CumulativeOutputTokens int     `json:"cumulativeOutputTokens"`
	CumulativeCost         float64 `json:"cumulativeCost"`
}

// DispatchTextDeltaInfo carries a child's streaming text.
type DispatchTextDeltaInfo struct {
	Name        string `json:"name"`
	DispatchID  string `json:"dispatchId,omitempty"`
	Delta       string `json:"delta"`
	Accumulated string `json:"accumulated"`
}

// DispatchPlanProposalInfo reports a plan a child proposed.
type DispatchPlanProposalInfo struct {
	Name          string `json:"name"`
	AgentID       string `json:"agentId"`
	PlanFilePath  string `json:"planFilePath"`
	PlanSlug      string `json:"planSlug"`
	PlanRequested bool   `json:"planRequested"`
}

// DispatchChildQuestionInfo is a question from a child. The child's run is
// blocked until the answer arrives.
type DispatchChildQuestionInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId"`
	RequestID  string `json:"requestId"`
	Question   string `json:"question"`
	Depth      int    `json:"depth"`
}

// AgentSpec declares an LLM-visible agent at runtime. Mirrors an agent
// markdown file's frontmatter. Specs live for the session; persisting them is
// the harness's job.
type AgentSpec struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
}

// DiscoverAgentsOpts scopes [Context.DiscoverAgents].
type DiscoverAgentsOpts struct {
	// Sources filters by origin: "extension", "user", "project", "extra".
	Sources []string `json:"sources,omitempty"`
	// ExtraDirs adds directories to the walk.
	ExtraDirs []string `json:"extraDirs,omitempty"`
	// BundleName scopes to one extension bundle.
	BundleName string `json:"bundleName,omitempty"`
	// Recursive walks subdirectories. Nil uses the engine default.
	Recursive *bool `json:"recursive,omitempty"`
}

// DiscoveredAgent is one agent found by [Context.DiscoverAgents].
type DiscoveredAgent struct {
	Name         string   `json:"name"`
	Path         string   `json:"path"`
	Source       string   `json:"source"`
	Parent       string   `json:"parent,omitempty"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
	// Meta holds frontmatter keys the engine does not itself consume.
	Meta map[string]string `json:"meta,omitempty"`
}

// DiscoveredContext is one context file found by [Context.WalkContextFiles].
type DiscoveredContext struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Source is "global", "project", "parent", or "include".
	Source string `json:"source"`
	// Level is the directory distance from cwd: 0 is cwd, 1 its parent.
	Level int `json:"level"`
}

// WalkContextFilesOpts scopes [Context.WalkContextFiles]. The pointer fields
// distinguish "not specified" from an explicit false.
type WalkContextFilesOpts struct {
	Cwd            string `json:"cwd,omitempty"`
	IncludeGlobal  *bool  `json:"includeGlobal,omitempty"`
	IncludeProject *bool  `json:"includeProject,omitempty"`
	ClaudeCompat   *bool  `json:"claudeCompat,omitempty"`
}
