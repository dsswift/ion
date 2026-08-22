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

	// ConversationID is the durable conversation identity for this session.
	// Unlike SessionKey, this ID is stable across engine restarts and
	// reattaches. Empty when no conversation is active.
	ConversationID string

	// RunID identifies the prompt-to-completion run in flight when the hook
	// fired. Empty when no run is active (session_start, a schedule or
	// webhook delivery, extension load).
	//
	// This is the engine-native run identity — the same value that appears as
	// run_id in the engine's own logs and telemetry, so it is the key to join
	// an extension's records against Ion's. For distributed tracing across
	// process boundaries use TraceID instead: run IDs are not W3C-shaped.
	RunID string

	// TraceID is the W3C trace-context trace-id of the run in flight: 32
	// lowercase hex characters, scoped to ONE prompt-to-completion run. Empty
	// when no run is active.
	//
	// Every engine log line and telemetry event emitted during the run carries
	// this same value, so an extension that exports its own spans can parent
	// them to the engine's trace and have the two streams correlate. It is
	// valid to place directly in a traceparent header for a downstream call:
	//
	//	traceparent: 00-<ctx.TraceID>-<span id you mint>-01
	//
	// The extension mints its own span id — its span IS a new span, so it is
	// the parent-id for the callee, not a value the engine supplies.
	//
	// Scope is the run rather than the session or conversation because a trace
	// represents one logical transaction. For long-lived correlation use
	// ConversationID; for the engine session use SessionKey. See
	// docs/observability/log-schema.md § Correlation-ID vocabulary.
	TraceID string

	// Depth is the dispatch depth of the session that fired the hook: 0 for
	// the root (orchestrator) session, 1 for a directly dispatched child,
	// 2 for a grandchild, and so on. This is the explicit root-vs-child
	// discriminator for hooks whose payload carries no agent identity
	// (session_start, session_end, turn_* and friends): a handler that
	// should only act for the root session branches on Depth == 0.
	// Mirrors AgentInfo.IsRoot on before_agent_start, which discriminates
	// per-firing rather than per-session.
	Depth int

	// DispatchId identifies the dispatch that owns this context. Empty for
	// the root session (Depth 0); populated for child sessions with the
	// dispatch ID minted when the agent was spawned, so per-dispatch state
	// can be keyed without inventing a session-local identity.
	DispatchId string

	Cwd    string
	Model  *ModelRef
	Config *ExtensionConfig

	// Event emission -- extensions emit typed data events, engine forwards to socket clients.
	Emit func(event types.EngineEvent)

	// Functional getters
	GetContextUsage func() *ContextUsage
	// GetTurn returns the live turn number of the run that fired the hook, or
	// 0 when no run is active (non-run fires like session_start/schedules) or
	// the accessor is unset. Wired in the session layer as a closure over the
	// backend's live turn counter, mirroring GetContextUsage. Never serialized
	// (func field); consumed only by callHook for hook_latency attribution.
	GetTurn         func() int64
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

	// CallTool dispatches an extension-initiated tool call through the session
	// registry. Content and IsError retain text-only compatibility; ContentItems
	// preserves additive typed MCP content for consumers that need it.
	CallTool func(toolName string, input map[string]interface{}) (*types.ToolResult, error)

	// CallToolWithContext is CallTool with an optional millisecond timeout.
	CallToolWithContext func(toolName string, input map[string]interface{}, timeoutMs *float64) (*types.ToolResult, error)

	// HTTPRequest performs outbound HTTP authenticated by the configured
	// operator or machine identity. Engine injects OAuth bearer or AWS SigV4
	// authentication; params contain no credential and response contains only
	// status/headers/body. TypeScript SDK exposes same ext/http_request path.
	HTTPRequest func(params OperatorHTTPRequestParams) (*OperatorHTTPResponse, error)

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
	// The per-call `model` override is honored on ALL dispatch paths,
	// including when invoked outside an active hook dispatch (e.g. from a
	// timer or scheduler callback). The fallback path carries the full
	// SendPromptPayload (text + model + bash-allowlist additions) to the
	// session manager via onSendMessage, which builds PromptOverrides from it
	// the same way the active-hook path does. Empty `model` means "use the
	// session default".
	//
	// `bashAllowlistAdditions` carries per-prompt, run-scoped plan-mode Bash
	// command-prefix allowances. They are unioned with the session-scoped
	// allowlist for the single run this prompt starts and are NEVER persisted
	// on the session — they apply only for the scope of this prompt's
	// execution turn. This is the mechanism a slash command dispatched as an
	// extension command (e.g. one loaded from a `.ion/commands/*.md` file with
	// an `allowed_bash_commands` frontmatter list) uses to perform its side
	// effect — running an allowed Bash command — while plan mode is active,
	// instead of waiting for plan-mode exit. An empty/nil slice is a no-op.
	// Like `model`, additions flow on every dispatch path — the active-hook /
	// command-execute path AND the timer/scheduler fallback path. There is no
	// per-feature divergence between the two paths.
	SendPrompt func(text string, model string, bashAllowlistAdditions []string) error

	// SendPromptPayload is the full-payload variant of SendPrompt. It carries
	// the same text/model/bash parameters plus a Kind classification that the
	// engine threads into PromptInjectedEvent.Kind and the wire field
	// InjectedPromptKind. Extensions should prefer ctx.sendPrompt() from the
	// TypeScript SDK (which calls ext/send_prompt including the kind field);
	// this func is wired by the engine to support the active-hook code path
	// when Kind is non-empty. Nil when the engine has not wired it (safe to
	// nil-check; callers fall back to SendPrompt when nil).
	SendPromptPayload func(payload SendPromptPayload) error

	// Suspend ends the LLM run for this dispatch without completing it, parking
	// the dispatch until a revive message arrives via sendPrompt. The parent's
	// OnComplete callback does NOT fire. When awaitingDispatchIDs is non-empty,
	// the dispatch stays parked until ALL listed child dispatches have completed
	// (suspendUntilAll semantics); when empty, the dispatch revives on the next
	// sendPrompt to this session (bare suspend semantics). Nil when not wired
	// (e.g. at depth 0 / the orchestrator — the orchestrator never suspends).
	Suspend func(awaitingDispatchIDs []string) error

	// Engine-native agent dispatch. Creates a child session within the engine
	// with optional extension loading, system prompt injection, and event streaming.
	DispatchAgent func(opts DispatchAgentOpts) (*DispatchAgentResult, error)

	// RecallAgent terminates a running background dispatch by agent name.
	// Returns true if a dispatch was found and recalled, false otherwise.
	RecallAgent func(name string, opts RecallAgentOpts) (bool, error)

	// SteerDispatch delivers a steering message to a running background
	// dispatch identified by its dispatchId. The message is injected into
	// the child's conversation as a user message at the next run-loop
	// checkpoint, reusing the existing steer channel mechanism. Returns a
	// SteerDispatchResult describing the delivery outcome.
	SteerDispatch func(dispatchID, message string) (SteerDispatchResult, error)

	// SteerDispatchByName delivers a steering message to a running background
	// dispatch identified by its agent name. This is the name-based peer of
	// SteerDispatch: where SteerDispatch requires the full collision-safe
	// dispatch ID returned by DispatchAgent, SteerDispatchByName resolves
	// by the human-readable agent name (e.g. "code-reviewer"). When multiple
	// dispatches share a name, the first one found is steered (matching
	// RecallAgent's non-deterministic name-based semantics). Use SteerDispatch
	// when the exact dispatch ID is available for precise targeting.
	SteerDispatchByName func(name, message string) (SteerDispatchResult, error)

	// SteerSelf delivers a message to the run that OWNS this context, with the
	// engine choosing the delivery mechanism based on that run's state:
	//
	//   - If the owning run is live, the message is injected onto its steer
	//     channel and surfaces at the next run-loop checkpoint (mid-turn). The
	//     SteerDispatchResult.Outcome is "steered".
	//   - If the owning run is idle (no active run), the message is sent as a
	//     fresh prompt via the normal SendPrompt path. The Outcome is "sent".
	//
	// This is the mechanism a harness uses to bubble a background dispatch's
	// completion back to the dispatching agent without it polling: the parent
	// (or any ancestor that owns this context) receives the result whether it
	// is mid-run or idle, so a busy parent is steered rather than having the
	// completion queue behind its live run until it happens to go idle.
	//
	// Depth-aware: at depth 0 the owning run is the session's main loop; at
	// depth N (a dispatched agent's own context) the owning run is that
	// dispatch's child run. The engine resolves the correct run; the caller
	// never names it. Nil when steer support is not wired (no registry).
	SteerSelf func(message string) (SteerDispatchResult, error)

	// SteerSelfWithKind is the classification-carrying variant of SteerSelf.
	//
	// kind is a types.InjectionKind wire value naming who authored the
	// message ("agent_completion", "checkin", "revive", ...). The engine
	// threads it through BOTH delivery arms — the steer channel when the
	// owning run is live, and the fresh prompt when it is idle — so the turn
	// is recorded as machine-authored either way, and consumers can classify
	// it without guessing from the text.
	//
	// SteerSelf is the kindless alias: it delivers identically but leaves the
	// turn unclassified, which is correct only when the message genuinely is a
	// user turn. A harness delivering a dispatch completion, a scheduled
	// check-in, or a revive should use this method — a machine-to-machine
	// message with no kind is rendered as a user bubble by every consumer that
	// reads the classification.
	SteerSelfWithKind func(message, kind string) (SteerDispatchResult, error)

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

	// ListDispatchState returns a point-in-time snapshot of every dispatch
	// currently active in this session's DispatchRegistry. All returned
	// entries carry Status="running" because the registry only tracks
	// in-flight dispatches — terminal entries are deregistered on completion.
	// Returns nil when dispatch support is not wired (e.g. a child session
	// whose context was built without a registry).
	ListDispatchState func() ([]DispatchStateEntry, error)

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

	// SetRunRecovery applies an extension-owned per-session recovery override.
	// It is available from session_start after session defaults resolve.
	SetRunRecovery func(config *types.RunRecoveryConfig)

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

	// Resource subsystem — producer side. Extensions declare resource
	// kinds they produce, publish items, and register query handlers
	// that respond when clients subscribe.
	//
	// DeclareResource registers this extension as the producer for a
	// resource kind on the session's broker. One producer per kind.
	DeclareResource func(decl types.ResourceDeclaration) error

	// PublishResource publishes a create/update/delete/mark_read delta
	// to all subscribers of the given kind. The broker fans out the
	// delta to every active subscription.
	PublishResource func(kind string, delta types.ResourceDelta) error

	// HandleResourceQuery registers a query handler for the given kind.
	// When a client subscribes, the broker calls this handler to get the
	// initial snapshot of items matching the subscription filter.
	HandleResourceQuery func(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error))

	// Notify sends a push notification through the engine's notification
	// pipeline. The engine formats the payload and routes it through
	// the relay's push channel. Extensions never speak relay protocol
	// directly. Notifications are signals, not payloads — they carry
	// enough to identify the resource and surface it to the user, not
	// the full content.
	Notify func(opts types.NotifyOpts) error

	// Intercept emits an engine_intercept event on the target session's stream.
	// The engine performs no routing beyond delivering the event; clients decide
	// how to render and whether to act on the Level hint. This is a
	// fire-and-forget signal — the engine does not track intercept state.
	// The extension's name is attached as InterceptSource by the engine;
	// extensions cannot set it themselves.
	Intercept func(opts InterceptOpts) error

	// ListSessions returns info about all active sessions in the engine.
	// Extensions use this to discover other sessions of the same extension
	// type for cross-session notification targeting. The engine returns
	// all sessions; the extension filters by ExtensionName on its side.
	ListSessions func() ([]SessionListEntry, error)

	// SendToSession sends a structured message to another session of the
	// same extension type. The target session must have a session_message
	// hook registered; if not, the engine returns an error. Same extension
	// type only — the engine enforces this by comparing extension names.
	SendToSession func(targetKey string, kind string, payload map[string]interface{}) error

	// FireSchedule triggers an immediate fire of the named schedule job,
	// reusing the existing fireJob machinery (in-flight guard, single-
	// concurrency arbitration, last-run recording). Returns nil on success
	// or a benign nil when the job is already in-flight. Returns an error
	// when the job ID is not found or no resolver is wired.
	FireSchedule func(jobID string) error

	// GetScheduleStatus returns status entries for registered schedule jobs.
	// When jobID is non-empty, only the matching job is returned (or an empty
	// slice when not found). When jobID is empty, all jobs on the session's
	// hosts are returned.
	GetScheduleStatus func(jobID string) ([]ScheduleStatusEntry, error)

	// RunOnceCheck coordinates cross-instance dedup for ctx.runOnce.
	// Returns (execute=true, "") when this instance wins the dedup check.
	// Returns (execute=false, reason) when another instance is running or
	// the operation was run recently enough to be debounced.
	// reason values: "in_progress", "debounced", "already_ran"
	RunOnceCheck func(operationID string, debounceMs int64) (execute bool, reason string)

	// RunOnceComplete records the outcome of a runOnce operation.
	// failed=true releases the lock without updating lastRun so the next
	// instance can retry immediately instead of waiting for debounce expiry.
	RunOnceComplete func(operationID string, failed bool)
}

// SessionListEntry describes a session as returned by ListSessions.
// Mirrors session.SessionInfo but lives in the extension package to
// avoid a circular dependency.
type SessionListEntry struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ExtensionName  string `json:"extensionName,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
}

// InterceptOpts configures an engine_intercept signal event. The engine
// routes the event to the target session (or the caller's session when
// TargetSessionKey is empty) and attaches no further semantics. Clients
// decide how to render and whether to act on the Level hint.
type InterceptOpts struct {
	// Level is a client hint about severity:
	//   "banner"   — informational, non-disruptive
	//   "redirect" — urgent, client may abort + re-prompt
	// The engine does not validate or branch on this value.
	Level string `json:"level"`

	// Title is a short headline. Required.
	Title string `json:"title"`

	// Message is the body content. For "redirect" level, clients may use
	// this as the injected user prompt if they choose to redirect.
	Message string `json:"message"`

	// TargetSessionKey identifies which session receives the event.
	// When empty, the event emits on the caller's own session.
	TargetSessionKey string `json:"targetSessionKey,omitempty"`

	// Metadata is an opaque map forwarded to clients unchanged.
	Metadata map[string]interface{} `json:"metadata,omitempty"`

	// Source is set by the engine from the host's extension name before
	// the event is emitted. Extensions cannot set this field directly;
	// the json:"-" tag ensures it is never deserialized from extension RPC.
	Source string `json:"-"`
}

// DiscoverAgentsOpts configures which directories to scan for agent definitions
// and the override precedence. Directories are listed in precedence order:
// later entries override earlier entries with the same agent name (stem).
//
// Named sources:
//
//	"extension" -- {extensionDir}/agents/ (agents packaged with the extension)
//	"user"      -- ~/.ion/agents/ (user-level agents)
//	"project"   -- {workingDir}/.ion/agents/ (project-scoped agents)
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

// DispatchStateEntry is a point-in-time snapshot of a single in-flight
// dispatch, returned by Context.ListDispatchState. Terminal entries are
// deregistered on completion and therefore absent; in-flight spans two
// states — "running" (actively working) and "suspended" (parked waiting on
// children or a revive).
type DispatchStateEntry struct {
	// DispatchID is the collision-safe unique ID for this dispatch instance.
	DispatchID string `json:"dispatchId"`
	// Name is the agent name (e.g. "code-reviewer").
	Name string `json:"name"`
	// Status is "running" for an active dispatch or "suspended" for a
	// parked one (waiting on child dispatches or a revive message).
	Status string `json:"status"`
	// ParentDispatchID is the dispatch ID of the parent dispatch, empty for
	// top-level dispatches (depth 1 whose parent is the depth-0 orchestrator).
	ParentDispatchID string `json:"parentDispatchId,omitempty"`
	// Depth is the nesting depth: 1 = direct child of the orchestrator,
	// 2 = grandchild, etc.
	Depth int `json:"depth"`
	// StartedAt is the UTC wall-clock time when the dispatch was registered.
	StartedAt string `json:"startedAt"`
	// ElapsedMs is the milliseconds elapsed since StartedAt at snapshot time.
	ElapsedMs int64 `json:"elapsedMs"`
	// ToolCount is the cumulative number of tool calls the dispatched child
	// has executed.
	ToolCount int `json:"toolCount"`
	// LastWork is the truncated most-recent activity snippet (streamed text
	// or "Using <tool>...").
	LastWork string `json:"lastWork,omitempty"`
	// LastActivityMs is the milliseconds since the child's last observed
	// event at snapshot time — the liveness discriminator: small and stable
	// means producing; large and growing means wedged. Zero when no
	// activity has been observed yet.
	LastActivityMs int64 `json:"lastActivityMs"`
	// ChildConversationID is the child session's conversation ID once known.
	// Lets a consumer read the child's live transcript (or harvest partial
	// work) directly from the conversation store.
	ChildConversationID string `json:"childConversationId,omitempty"`
	// PendingChildren is retained for compatibility. WaitingOn carries the
	// complete task-and-child wait metadata for parked dispatches.
	PendingChildren []string           `json:"pendingChildren,omitempty"`
	WaitingOn       *DispatchWaitingOn `json:"waitingOn,omitempty"`
}

// DispatchWaitingOn identifies work holding a dispatch parked.
type DispatchWaitingOn struct {
	TaskIDs          []string `json:"taskIds,omitempty"`
	ChildDispatchIDs []string `json:"childDispatchIds,omitempty"`
}

// ContextUsage reports current context window utilization.
//
// Percent is UNBOUNDED: it is the true Tokens/window ratio and may exceed
// 100, which means the conversation holds more tokens than the window it is
// measured against. Extensions that gate on context pressure should prefer
// Tokens (an absolute count) over Percent when the comparison must hold
// across a model switch.
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
	BuildIdentity    string `json:"buildIdentity,omitempty"`
	// ExtensionAllowlist, when non-empty, restricts which extensions Host.Load
	// will spawn (feature 0011 / D-020, issue #308). The session layer copies
	// the enterprise allowlist into this field so every load path (initial,
	// daemon-restart re-registration, respawn) consults the same policy. Empty
	// means no restriction. Not serialized to the subprocess — it is engine-side
	// enforcement metadata, not extension init config.
	ExtensionAllowlist []types.ExtensionAllowlistEntry `json:"-"`
}

// ToolDefinition describes a tool registered by an extension.
type ToolDefinition struct {
	Name         string
	Description  string
	Parameters   map[string]interface{}
	PlanModeSafe bool
	Execute      func(params interface{}, ctx *Context) (*types.ToolResult, error)
}

// CommandDefinition describes a slash command registered by an extension.
type CommandDefinition struct {
	Description string
	Execute     func(args string, ctx *Context) error
}
