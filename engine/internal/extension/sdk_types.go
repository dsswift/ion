package extension

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// HookHandler is a generic handler function.
// The ctx parameter carries session context.
// The payload is hook-specific data.
// Returns optional result (nil = no opinion) and error.
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)

// Context is the extension execution context passed to hook handlers.
type Context struct {
	// SessionKey identifies the engine session that fired the hook (the same
	// key clients pass on `start_session`/`send_prompt`). Empty when the
	// context does not originate from a live session (e.g. during extension
	// load before any session is bound). Extensions can use this as the key
	// of a module-level `Map` to keep per-session state across hook calls.
	SessionKey string

	Cwd    string
	Model  *ModelRef
	Config *ExtensionConfig

	// Event emission -- extensions emit typed data events, engine forwards to socket clients.
	Emit func(event types.EngineEvent)

	// Functional getters
	GetContextUsage func() *ContextUsage
	Abort           func()
	RegisterAgent   func(name string, handle types.AgentHandle)
	DeregisterAgent func(name string)
	ResolveTier     func(name string) string

	// RegisterAgentSpec registers an LLM-visible agent definition at runtime.
	// Used by capability_match hook handlers to promote a draft specialist
	// into a live agent the Agent tool can dispatch on the very next call.
	// Specs persist for the session's lifetime in memory; file persistence
	// is the harness's job.
	RegisterAgentSpec   func(spec types.AgentSpec)
	DeregisterAgentSpec func(name string)
	LookupAgentSpec     func(name string) (types.AgentSpec, bool)

	// Process lifecycle management for extension-spawned subprocesses.
	RegisterProcess     func(name string, pid int, task string) error
	DeregisterProcess   func(name string)
	ListProcesses       func() []ProcessInfo
	TerminateProcess    func(name string) error
	CleanStaleProcesses func() int

	// Agent discovery. Walks conventional directories for .md agent definitions
	// with configurable layer precedence. Harness engineers control which sources
	// are included and which layer overrides which.
	DiscoverAgents func(opts DiscoverAgentsOpts) (*DiscoverAgentsResult, error)

	// Tool suppression. Extensions call this during session_start to remove
	// built-in tools from the LLM's tool set for subsequent runs.
	SuppressTool func(name string)

	// CallTool dispatches an extension-initiated tool call through the
	// session's tool registry: built-in tools, MCP-registered tools, and
	// extension-registered tools (any host in the loaded group). Returns
	// (content, isError, error).
	//
	// Permissions: subject to the session's permission policy. "deny"
	// decisions resolve with `(content, true, nil)` carrying a human-readable
	// reason. "ask" decisions auto-deny with a clear message because
	// extension calls cannot block on user elicitation -- the harness must
	// configure an explicit allow rule for the specific tool/extension combo.
	//
	// Returns a non-nil Go error only for unknown-tool lookups (so the SDK
	// promise rejects on programming errors). Tool-internal failures resolve
	// as `(errorString, true, nil)`.
	//
	// Side effects: does NOT fire per-tool hooks (`bash_tool_call`, etc.) or
	// `permission_request`. Both would re-enter the calling extension and
	// create surprising recursion. Audit log entries from the permission
	// engine still fire.
	CallTool func(toolName string, input map[string]interface{}) (string, bool, error)

	// CallToolWithContext is like CallTool but accepts an optional timeout in
	// milliseconds. When timeoutMs is non-nil, the tool call is bounded by
	// that deadline. This is wired by the ext/call_tool RPC handler when the
	// extension provides a timeout parameter.
	CallToolWithContext func(toolName string, input map[string]interface{}, timeoutMs *float64) (string, bool, error)

	// SendPrompt queues a fresh prompt on this session's agent loop. The
	// call returns once the engine has accepted (or rejected) the prompt;
	// it does NOT wait for the LLM to finish. `model` is an optional
	// per-prompt model override -- pass "" to use the session default.
	//
	// Slash commands and hook handlers can both call this. Common patterns:
	// `/cloud <message>` forces a remote model + sends the prompt;
	// `session_start` primes the agent with a kickoff prompt.
	//
	// Recursion hazard: a `before_prompt` handler that calls SendPrompt
	// triggers a new run, which fires `before_prompt` again. Unbounded
	// recursion is checked only by the engine's prompt queue depth -- the
	// extension is responsible for guarding its own loops (e.g. with a
	// per-session "in-flight" flag stored on a sessionKey-keyed Map).
	//
	// When invoked outside an active hook dispatch (e.g. from a timer or
	// scheduler callback), the per-call `model` override is ignored; the
	// session default is used. This is a fallback path used by the host RPC
	// handler only — direct in-process callers always honor `model`.
	SendPrompt func(text string, model string) error

	// Engine-native agent dispatch. Creates a child session within the engine
	// with optional extension loading, system prompt injection, and event streaming.
	DispatchAgent func(opts DispatchAgentOpts) (*DispatchAgentResult, error)

	// RecallAgent terminates a running background dispatch by agent name.
	// Returns true if a dispatch was found and recalled, false otherwise.
	RecallAgent func(name string, opts RecallAgentOpts) (bool, error)

	// Elicit raises an elicitation request that fans out to: (a) every
	// connected client as an engine_elicitation_request event for UI render,
	// and (b) the elicitation_request extension hook so other extensions can
	// observe or respond. The first non-nil reply wins. Returns the response
	// map and a cancelled flag. The harness owns the schema/url shape.
	Elicit func(info ElicitationRequestInfo) (map[string]interface{}, bool, error)

	// SearchHistory searches the conversation history for content that may
	// have been compacted or cleared from the active context window. Returns
	// matching snippets with metadata. Useful for extensions that need to
	// recover details from earlier in the conversation.
	SearchHistory func(query string, maxResults int) ([]HistoryMatch, error)

	// GetSessionMemory returns the current session memory content for this
	// session. Returns empty string when session memory is not active or
	// no summary has been generated yet.
	GetSessionMemory func() (string, error)

	// SetSessionMemory replaces the session memory with custom content and
	// persists it to disk. Extensions can use this to provide their own
	// summarization strategies, overriding the engine's background summarizer.
	SetSessionMemory func(content string) error

	// SetPlanMode imperatively enables or disables plan mode for this session.
	// The engine flips session state, emits PlanModeChangedEvent so consumers
	// can mirror the new state, and (when enabled) ensures a planFilePath is
	// allocated. When disabled, the plan file path is preserved so a
	// subsequent re-enable reuses it (same plan ID semantics as any other
	// harness-initiated toggle). Nil when not wired (e.g. in child-dispatch
	// sessions that have no plan-mode capability).
	//
	// source is a free-form string logged for observability (e.g.
	// "extension", "slash_command", "session_start"). It does not affect
	// plan-mode semantics.
	SetPlanMode func(enabled bool, source string)

	// GetPlanMode returns the current plan-mode state for this session:
	// (enabled, planFilePath). planFilePath is non-empty whenever a plan file
	// has been allocated for the session (even if plan mode is currently off —
	// the path is preserved across toggles until the session is reset).
	// Nil when not wired.
	GetPlanMode func() (enabled bool, planFilePath string)

	// LLMCall fires a one-shot, no-tools, no-loop inference call against the
	// session's provider registry. Returns the accumulated assistant text
	// plus usage / cost telemetry. Designed for harness-internal extraction,
	// classification, and routing prompts that should observe Ion's hook
	// surface (notably before_provider_request) without paying the cost of a
	// full dispatchAgent or a direct provider HTTP bypass.
	//
	// Fires before_provider_request once per invocation so handlers that
	// track outbound model calls see both agent-loop traffic and lightweight
	// inference traffic uniformly. Emits exactly one engine_llm_call event
	// after the call completes, carrying observability metadata (model,
	// providerID, latencyMs, tokens, cost, jsonMode) — never the prompt or
	// response content. Errors return (nil, error); no engine_llm_call event
	// fires on the error path.
	//
	// Nil when the session has no extension wiring (rare; defensive guard).
	LLMCall func(opts LLMCallOpts) (*LLMCallResult, error)
}

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
}

// DispatchAgentResult holds the outcome of a dispatched agent.
type DispatchAgentResult struct {
	Name                     string  `json:"name"`
	Output                   string  `json:"output"`
	ExitCode                 int     `json:"exitCode"`
	Elapsed                  float64 `json:"elapsed"`
	Cost                     float64 `json:"cost"`
	InputTokens              int     `json:"inputTokens"`
	OutputTokens             int     `json:"outputTokens"`
	CacheReadInputTokens     int     `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int     `json:"cacheCreationInputTokens,omitempty"`
	SessionID                string  `json:"sessionId,omitempty"`

	// PlanFilePath is the absolute path of the plan file written by the
	// child session. Non-empty only when the child was in plan mode and
	// wrote a plan (regardless of whether it called ExitPlanMode).
	PlanFilePath string `json:"planFilePath,omitempty"`

	// PlanExited is true when the child called ExitPlanMode (the run
	// terminated because the model proposed a plan for approval). When
	// false and PlanFilePath is non-empty, the child was in plan mode but
	// finished without proposing (e.g. hit max turns or was recalled).
	PlanExited bool `json:"planExited,omitempty"`
}

// DispatchError describes a failed background dispatch.
type DispatchError struct {
	Name     string  `json:"name"`
	Message  string  `json:"message"`
	ExitCode int     `json:"exitCode"`
	Elapsed  float64 `json:"elapsed"`
}

// RecallInfo describes a recalled (cancelled) background dispatch.
type RecallInfo struct {
	Name      string  `json:"name"`
	Reason    string  `json:"reason"`
	Elapsed   float64 `json:"elapsed"`
	ToolCount int     `json:"toolCount"`
}

// RecallAgentOpts configures a recall operation.
type RecallAgentOpts struct {
	Reason string `json:"reason,omitempty"`
}

// --- Phase 2: Lifecycle event callback payloads ---

// DispatchToolStartInfo carries data for the OnToolStart callback.
type DispatchToolStartInfo struct {
	Name     string `json:"name"`
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
}

// DispatchToolEndInfo carries data for the OnToolEnd callback.
type DispatchToolEndInfo struct {
	Name     string `json:"name"`
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
	Content  string `json:"content"`
}

// DispatchToolErrorInfo carries data for the OnToolError callback.
type DispatchToolErrorInfo struct {
	Name     string `json:"name"`
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
	Content  string `json:"content"`
}

// DispatchUsageInfo carries per-turn and cumulative usage data.
type DispatchUsageInfo struct {
	Name string `json:"name"`

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

// DiscoverAgentsOpts configures which directories to scan for agent definitions
// and the override precedence. Directories are listed in precedence order:
// later entries override earlier entries with the same agent name (stem).
//
// Named sources:
//   "extension" -- {extensionDir}/agents/ (agents packaged with the extension)
//   "user"      -- ~/.ion/agents/ (user-level agents)
//   "project"   -- {workingDir}/.ion/agents/ (project-scoped agents)
//
// Example: ["extension", "user", "project"] means extension agents are defaults,
// user agents override them, project agents override both.
type DiscoverAgentsOpts struct {
	// Sources lists named agent sources in precedence order (later overrides earlier).
	// Valid values: "extension", "user", "project".
	// If empty, defaults to ["extension", "user", "project"].
	Sources []string `json:"sources,omitempty"`
	// ExtraDirs adds arbitrary directories to scan (appended after named sources).
	ExtraDirs []string `json:"extraDirs,omitempty"`
	// BundleName filters to a specific bundle subdirectory (e.g., "cloudops").
	// If empty, all bundles in each source directory are included.
	BundleName string `json:"bundleName,omitempty"`
	// Recursive walks subdirectories within each agent directory. Default true.
	Recursive *bool `json:"recursive,omitempty"`
}

// DiscoveredAgent represents a parsed agent definition returned to extensions.
type DiscoveredAgent struct {
	Name         string            `json:"name"`
	Path         string            `json:"path"`
	Source       string            `json:"source"` // "extension", "user", "project", or "extra"
	Parent       string            `json:"parent,omitempty"`
	Description  string            `json:"description,omitempty"`
	Model        string            `json:"model,omitempty"`
	Tools        []string          `json:"tools,omitempty"`
	SystemPrompt string            `json:"systemPrompt,omitempty"`
	Meta         map[string]string `json:"meta,omitempty"`
}

// DiscoverAgentsResult holds the discovered agents.
type DiscoverAgentsResult struct {
	Agents []DiscoveredAgent `json:"agents"`
}

// ModelRef identifies the active model and its context window.
type ModelRef struct {
	ID            string
	ContextWindow int
}

// HistoryMatch represents a single search result from conversation history.
// Mirrors conversation.HistoryMatch for the extension SDK boundary.
type HistoryMatch struct {
	Index     int    `json:"index"`
	Role      string `json:"role"`
	Type      string `json:"type"`
	Snippet   string `json:"snippet"`
	ToolName  string `json:"toolName,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
}

// ContextUsage reports current context window utilization.
type ContextUsage struct {
	Percent int
	Tokens  int
	Cost    float64
}

// ExtensionConfig carries configuration for an extension instance.
type ExtensionConfig struct {
	ExtensionDir     string `json:"extensionDir"`
	Model            string `json:"model,omitempty"`
	WorkingDirectory string `json:"workingDirectory"`
	McpConfigPath    string `json:"mcpConfigPath,omitempty"`
}

// ToolDefinition describes a tool registered by an extension.
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  map[string]interface{}
	Execute     func(params interface{}, ctx *Context) (*types.ToolResult, error)
}

// CommandDefinition describes a slash command registered by an extension.
type CommandDefinition struct {
	Description string
	Execute     func(args string, ctx *Context) error
}
