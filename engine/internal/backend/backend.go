package backend

import (
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// RunBackend abstracts the LLM execution backend.
// Both ApiBackend (direct API) and CliBackend (Claude CLI wrapper) implement this.
type RunBackend interface {
	StartRun(requestID string, options types.RunOptions)
	Cancel(requestID string) bool
	IsRunning(requestID string) bool

	// WriteToStdin sends a follow-up message to a running process over stdin.
	// Used by CliBackend for bidirectional stream-json communication.
	// ApiBackend returns nil (no stdin pipe -- uses conversation injection).
	WriteToStdin(requestID string, msg interface{}) error

	// FlushConversations persists every in-flight run's conversation to disk.
	// Best-effort; intended for shutdown paths so partially streamed turns
	// survive the engine being killed mid-run.
	FlushConversations()

	// Event channels
	OnNormalized(func(runID string, event types.NormalizedEvent))
	OnExit(func(runID string, code *int, signal *string, sessionID string))
	OnError(func(runID string, err error))
}

// ToolCallInfo describes a tool invocation for the onToolCall hook.
type ToolCallInfo struct {
	ToolName string
	ToolID   string
	Input    map[string]interface{}
}

// ToolCallResult is the hook response that can block a tool call.
type ToolCallResult struct {
	Block  bool
	Reason string
}

// BeforeProviderRequestInfo mirrors extension.BeforeProviderRequestInfo for the
// backend layer. The backend package deliberately does not import extension
// (to keep the agent loop independent of hook dispatch concerns), so we
// duplicate the shape and let the session layer translate between the two.
//
// Field semantics are identical to extension.BeforeProviderRequestInfo — see
// that type for documentation. New fields added here must also be added there
// (and vice versa); the translation in session/prompt_runconfig.go fails
// loudly at the call site if shapes drift.
type BeforeProviderRequestInfo struct {
	Provider        string
	Model           string
	TurnNumber      int
	MessageCount    int
	ToolCount       int
	HasSystemPrompt bool
	MaxTokens       int
}

// EarlyStopDecisionInfo mirrors extension.EarlyStopDecisionInfo for the
// backend layer. Same backend↔extension duplication pattern as
// BeforeProviderRequestInfo: backend must not import extension, so this
// shape is kept identical and translated in session/prompt_runconfig.go.
// See extension.EarlyStopDecisionInfo for full field docs.
type EarlyStopDecisionInfo struct {
	RunID                  string
	Model                  string
	TurnNumber             int
	StopReason             string
	CumulativeOutputTokens int
	Budget                 int
	ThresholdPct           int
	ContinuationCount      int
	MaxContinuations       int
	LastContinuationDelta  int
	WouldContinue          bool
	IsSubagent             bool
}

// EarlyStopDecisionResult mirrors extension.EarlyStopDecisionResult for the
// backend layer. Pointer ForceContinue lets handlers express "force stop"
// and "force continue" distinctly from "no opinion".
type EarlyStopDecisionResult struct {
	ForceContinue        *bool
	OverrideBudget       int
	OverrideThresholdPct int
	ContinueMessage      string
}

// EarlyStopContinuedInfo mirrors extension.EarlyStopContinuedInfo for the
// backend layer. Observe-only payload.
type EarlyStopContinuedInfo struct {
	RunID                  string
	TurnNumber             int
	ContinuationCount      int
	Pct                    int
	CumulativeOutputTokens int
	Budget                 int
	InjectedText           string
}

// PlanModeAutoExitHookInfo mirrors extension.BeforePlanModeAutoExitInfo
// for the backend layer. The backend deliberately does not import
// extension (to keep the agent loop independent of hook dispatch
// concerns), so we duplicate the shape and let the session layer
// translate between the two.
//
// Field semantics are identical to extension.BeforePlanModeAutoExitInfo
// — see that type for documentation. New fields added here must also be
// added there (and vice versa); the translation in
// session/prompt_runconfig.go fails loudly at the call site if shapes
// drift.
type PlanModeAutoExitHookInfo struct {
	SessionID     string
	RunID         string
	StopReason    string
	PlanFilePath  string
	AssistantText string
	EmittedTools  []string
}

// TelemetryCollector is an optional interface for telemetry injection.
type TelemetryCollector interface {
	Event(name string, payload map[string]interface{}, ctx map[string]interface{})
	StartSpan(name string, attrs map[string]interface{}) Span
}

// Span tracks the lifetime of a telemetry span.
type Span interface {
	End(attrs map[string]interface{}, errMsg ...string)
}

// RunHooks bundles every per-run callback the ApiBackend may invoke during a
// run loop. All fields are optional; nil callbacks are treated as no-ops.
//
// The hooks live on each activeRun (rather than the singleton backend) so that
// concurrent runs from different sessions cannot trample each other's
// closures. See engine/internal/backend/api_backend.go for usage.
type RunHooks struct {
	// OnToolCall fires before tool execution and may block the call.
	OnToolCall func(ToolCallInfo) (*ToolCallResult, error)
	// OnPerToolHook fires before ("before") and after ("after") each tool.
	OnPerToolHook func(toolName string, info interface{}, phase string) (interface{}, error)

	OnTurnStart func(runID string, turnNumber int)
	OnTurnEnd   func(runID string, turnNumber int)

	// OnBeforeProviderRequest fires immediately before each outbound LLM
	// provider call from the agent loop. Observe-only: the callback receives
	// a descriptor of the pending request and any return value is discarded.
	// Implementations must not block — the agent loop dispatches the request
	// synchronously after this callback returns.
	OnBeforeProviderRequest func(runID string, info BeforeProviderRequestInfo)

	// OnBeforePrompt receives the run ID and current user prompt; may return a
	// rewritten prompt and additional system-prompt content.
	OnBeforePrompt func(runID string, prompt string) (rewrittenPrompt, extraSystemPrompt string)

	// OnPlanModePrompt provides plan-mode prompt customization.
	// Returns (customPrompt, customTools, customSparseReminder). Empty values
	// mean "use the engine default" for that field. The sparse reminder
	// override (third return) is cached on the activeRun and used for all
	// per-turn reminder injections in place of buildPlanModeSparseReminder.
	OnPlanModePrompt func(planFilePath string) (customPrompt string, customTools []string, customSparseReminder string)

	// OnPlanModeEnter is called when the LLM invokes the EnterPlanMode sentinel
	// tool. The callback fires the before_plan_mode_enter hook and — if allowed
	// — flips the session into plan mode. Returns (allowed, reason, planFilePath).
	// When allowed=false, reason is returned to the LLM in the tool result.
	// Nil callback means auto-approve (used in tests and CLI backend).
	OnPlanModeEnter func() (allowed bool, reason string, planFilePath string)

	// OnPlanModeExit is called when the LLM invokes the ExitPlanMode sentinel
	// tool, before the run is terminated and the plan-ready card is shown.
	// The callback fires the before_plan_mode_exit hook so extensions can veto
	// the exit (e.g. to send the model back for more planning). Returns
	// (allowed, reason). When allowed=false, the run continues in plan mode and
	// reason is returned to the LLM in the tool result. Nil callback means
	// auto-approve (always allow the exit).
	OnPlanModeExit func(planFilePath string) (allowed bool, reason string)

	// OnPlanModeAutoExit is called immediately before the runloop
	// synthesizes a deterministic ExitPlanMode at end-of-turn (the
	// safety net for "model ended plan-mode turn without calling
	// ExitPlanMode"). The callback fires the before_plan_mode_auto_exit
	// hook so extensions can suppress the synthesis, override the
	// PlanFilePath used in the synthesized PermissionDenial, or override
	// the human-readable Reason recorded on the denial / emitted on
	// PlanModeAutoExitEvent.
	//
	// Returns (suppress, planFilePathOverride, reasonOverride). When
	// suppress=true the engine skips synthesis entirely. When the
	// override strings are non-empty, the engine substitutes them for
	// its own defaults. Nil callback (or no extensions wired) means
	// "no opinion — proceed with defaults."
	OnPlanModeAutoExit func(info PlanModeAutoExitHookInfo) (suppress bool, planFilePathOverride, reasonOverride string)

	// GetSessionPlanFilePath retrieves the session-level planFilePath when
	// the run's own planFilePath is empty. This happens when the model calls
	// ExitPlanMode outside of engine plan mode (prompt-level plan mode) — the
	// run was created with planMode=false and planFilePath="", but the session
	// still retains the planFilePath from a prior plan-mode run. Without this
	// fallback, the ExitPlanMode interception emits a plan_proposal with an
	// empty planFilePath, which consumers cannot act on.
	GetSessionPlanFilePath func() string

	// OnSystemInject fires before each engine-injected steering message.
	// Returns (text, suppress). If suppress is true, the message is not injected.
	// If text is non-empty, it replaces the default.
	OnSystemInject func(kind, defaultText string, turn, maxTurns int) (text string, suppress bool)

	// OnBeforeEarlyStopDecision fires after the model emits end_turn / stop
	// and the engine has updated cumulative output tokens, but before it
	// evaluates the continuation criteria. Handlers can return a non-nil
	// EarlyStopDecisionResult to force the verdict, override the budget /
	// threshold for the remainder of the run, or supply a custom prompt.
	// Nil callback means no handler is wired (engine uses its default).
	OnBeforeEarlyStopDecision func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult

	// OnEarlyStopContinued fires after a continuation has been injected
	// (or suppressed by OnSystemInject) and the loop is about to start a
	// new turn. Observe-only.
	OnEarlyStopContinued func(info EarlyStopContinuedInfo)

	// OnSessionBeforeCompact may cancel a compaction (return true to cancel).
	OnSessionBeforeCompact func(runID string) bool
	// OnSessionCompact observes a completed compaction.
	OnSessionCompact func(runID string, info interface{})

	// OnRequestCompactSummary is an optional harness-owned summariser
	// invoked during proactive / reactive compaction in place of the
	// engine's built-in regex fact extractor. The handler receives the
	// compaction strategy ("auto" for proactive token-limit driven,
	// "reactive" for prompt_too_long retry) along with the pre-compaction
	// message slice (already filtered through
	// MessagesAfterLastCompactBoundary so prior summaries are not in
	// scope) and returns (summary, ok). When ok is true, summary is
	// used verbatim as the boundary block's Summary field. When ok is
	// false (or the field is nil), the engine falls back to its
	// FormatFactsSummary(ExtractFacts(...)) pipeline.
	//
	// The strategy parameter lets harness summarisers tune their output
	// to the trigger — e.g. a reactive summary may want to be more
	// aggressive (fewer tokens) because the provider just rejected the
	// prompt, while an auto summary can afford a richer rendering.
	//
	// The engine never blocks on this callback; the runloop dispatches
	// synchronously. Harness implementations that want to call an LLM
	// must do so with a bounded timeout and surface failures by
	// returning ("", false) — never by blocking the run.
	//
	// This is the engine-side bridge for the optional
	// "compact_summary_request" hook on the extension SDK. See
	// docs/hooks/reference.md and the runloop_compaction.go logging for
	// the "path=hook" / "path=regex" markers.
	OnRequestCompactSummary func(runID string, strategy string, messages []types.LlmMessage) (summary string, ok bool)

	OnFileChanged func(runID string, path string, action string)

	OnPermissionRequest func(runID string, info interface{})
	OnPermissionDenied  func(runID string, info interface{})

	OnPermissionClassify func(toolName string, input map[string]interface{}) string
}

// RunConfig packages all per-run state that varies between sessions. It is
// passed to ApiBackend.StartRunWithConfig and stored on the matching
// activeRun. Nil-valued fields fall back to backend defaults (no permission
// engine, no external tools, no telemetry, etc.).
//
// Splitting these out of the backend singleton fixes the multi-session
// interlacing bug: with one shared ApiBackend serving multiple concurrent
// sessions, per-session hooks were globally mutated on every SendPrompt. A
// run from session A would then fire hooks captured for session B. Now each
// run captures its own snapshot.
type RunConfig struct {
	Hooks RunHooks

	PermEngine    *permissions.Engine
	SandboxCfg    *sandbox.Config
	SecurityCfg   *types.SecurityConfig
	ExternalTools []types.LlmToolDef
	McpToolRouter func(name string, input map[string]interface{}) (content string, isErr bool, err error)
	AgentSpawner  tools.AgentSpawner
	Telemetry     TelemetryCollector
	Timeouts      *types.TimeoutsConfig

	// DefaultModel is the engine-wide default model from EngineConfig.
	// Used as a fallback when the requested model doesn't resolve to a
	// provider (e.g. an unrecognized tier alias in an agent .md).
	DefaultModel string

	// EarlyStopContinue carries the engine-wide defaults for the early-stop
	// continuation feature (from ~/.ion/engine.json or built-in defaults).
	// Nil means "use built-in defaults" (types.EarlyStopDefaults()). Per-run
	// RunOptions fields take precedence over this; the
	// before_early_stop_decision hook overrides both.
	EarlyStopContinue *types.EarlyStopContinueConfig

	// PlanModeAutoExitOnEndTurn captures
	// EngineRuntimeConfig.Limits.PlanModeAutoExitOnEndTurn so the runloop
	// can resolve the synthesis safety-net setting without reaching back
	// to the full engine config. Nil means "use the built-in default
	// (true)"; &true / &false make the choice explicit. Per-run
	// RunOptions.PlanModeAutoExit overrides this; the
	// before_plan_mode_auto_exit hook overrides both.
	PlanModeAutoExitOnEndTurn *bool

	// GetSessionMemory returns the current session memory content for use
	// as a zero-cost compaction summary. Set by the session layer from
	// SessionMemory.GetMemory. Nil means session memory is not available.
	GetSessionMemory func() string

	// GetLastSummarizedEntryID returns the entry ID boundary of the most
	// recent session memory summary. Used by the compaction system to
	// validate that the memory covers the messages being dropped.
	GetLastSummarizedEntryID func() string

	// ResetMemoryTracking resets the session memory debounce baselines
	// to the given token count after compaction reduces the message count.
	ResetMemoryTracking func(tokens int)

	// MaxToolResultChars caps the character count of any single tool result
	// added to the conversation. Threaded from engine.json compaction config.
	// Zero means "use built-in default" (conversation.DefaultMaxToolResultChars).
	// Per-run RunOptions.MaxToolResultChars takes precedence when non-zero.
	MaxToolResultChars int
}
