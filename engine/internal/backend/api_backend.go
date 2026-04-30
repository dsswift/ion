package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/insights"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"golang.org/x/sync/errgroup"
)

// convSuffixCounter is a fallback used only when crypto/rand fails (it never
// has, but the disk could be full at exactly the wrong moment). Combined with
// the millisecond timestamp it still produces unique conversation IDs.
var convSuffixCounter uint64

// newConvSuffix returns a 12-hex-char random suffix. Callers prepend a
// millisecond timestamp; the combined id is the conversation file name.
// Two runs that begin in the same millisecond see different suffixes, so
// their conversation files cannot collide.
func newConvSuffix() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%012x", atomic.AddUint64(&convSuffixCounter, 1))
	}
	return hex.EncodeToString(b[:])
}

// activeRun tracks the state of a single in-flight agent loop.
//
// Per-run configuration (hooks, permission engine, external tools, agent
// spawner, telemetry, etc.) lives here rather than on the parent ApiBackend
// so concurrent runs cannot overwrite each other's closures. The cfg pointer
// is set once at StartRun and read without locking from goroutines that the
// run owns; it must not be mutated after StartRun returns.
type activeRun struct {
	mu        sync.Mutex
	requestID string
	conv      *conversation.Conversation
	cancel    context.CancelFunc
	// turnCount is read by Cancel (and other RPC paths) while runLoop is
	// still mutating it. Atomic load/store gives the race detector the
	// happens-before edge it needs without forcing every read site to
	// take run.mu.
	turnCount         atomic.Int64
	totalCost         float64
	startTime         time.Time
	steerCh           chan string
	exitPlanMode      bool                     // set when ExitPlanMode tool is called during plan mode
	permissionDenials []types.PermissionDenial // tools intercepted/denied (e.g. ExitPlanMode sentinel)
	planMode          bool                     // true when this run is in plan mode
	planFilePath      string                   // only writable file during plan mode

	cfg *RunConfig // captured per-run config; nil means "no hooks, no per-run state"
}

// ApiBackend is the direct-API backend that runs an agentic loop against
// an LLM provider, executing tools and managing conversation state.
//
// State on this struct is process-wide: the active-run registry, the three
// event-routing callbacks (set once by the server wiring), and the auth
// resolver. Per-session state (permissions, hooks, external tools, agent
// spawner, telemetry) is no longer here -- it travels on each run's
// *RunConfig. See StartRunWithConfig.
type ApiBackend struct {
	mu         sync.Mutex
	activeRuns map[string]*activeRun

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)

	authResolver *auth.Resolver
}

// NewApiBackend creates an ApiBackend ready for use.
func NewApiBackend() *ApiBackend {
	return &ApiBackend{
		activeRuns: make(map[string]*activeRun),
	}
}

// OnNormalized registers the callback for normalized events.
func (b *ApiBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onNormalized = fn
}

// OnExit registers the callback for run exit events.
func (b *ApiBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onExit = fn
}

// OnError registers the callback for run errors.
func (b *ApiBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onError = fn
}

// SetAuthResolver attaches an auth resolver for API key resolution. Auth
// resolution is process-wide (one set of provider credentials per ion
// install), so this remains a singleton setter.
func (b *ApiBackend) SetAuthResolver(r *auth.Resolver) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.authResolver = r
}

// StartRun begins an agent loop with no per-run config (no hooks, no
// permission engine, no external tools). Equivalent to StartRunWithConfig
// with a nil cfg. Provided for callers and tests that exercise the API
// backend in isolation.
func (b *ApiBackend) StartRun(requestID string, options types.RunOptions) {
	b.StartRunWithConfig(requestID, options, nil)
}

// StartRunWithConfig begins an agent loop in a background goroutine and
// attaches the supplied RunConfig to the run. Hooks, permission engine,
// external tools, agent spawner, telemetry, and security config are all
// captured on the activeRun -- they cannot be mutated after this returns,
// which is what guarantees session isolation across concurrent runs.
//
// A nil cfg is permitted; the run executes with no hooks and no per-run
// state. Existing call sites that don't need session integration (tests,
// the Agent tool's child runs) keep using StartRun.
func (b *ApiBackend) StartRunWithConfig(requestID string, options types.RunOptions, cfg *RunConfig) {
	ctx, cancel := context.WithCancel(context.Background())

	run := &activeRun{
		requestID:    requestID,
		cancel:       cancel,
		startTime:    time.Now(),
		steerCh:      make(chan string, 4),
		planMode:     options.PlanMode,
		planFilePath: options.PlanFilePath,
		cfg:          cfg,
	}

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	go b.runLoop(ctx, run, options)
}

// FlushConversations persists every active run's conversation to disk.
// Called from shutdown paths (signal handler) so partially streamed turns
// are not lost when the engine is killed mid-run.
func (b *ApiBackend) FlushConversations() {
	b.mu.Lock()
	runs := make([]*activeRun, 0, len(b.activeRuns))
	for _, r := range b.activeRuns {
		runs = append(runs, r)
	}
	b.mu.Unlock()
	for _, run := range runs {
		if run.conv == nil {
			continue
		}
		if err := conversation.Save(run.conv, ""); err != nil {
			utils.Log("ApiBackend", fmt.Sprintf("FlushConversations: save failed runID=%s err=%s", run.requestID, err.Error()))
		}
	}
}

// cancelWatchdogGrace is the grace period after Cancel before the watchdog
// force-emits an exit and removes the run from activeRuns. Tuned long enough
// for cooperative tool cancellations to land via ctx, short enough that the
// frontend tab returns to idle without obvious lag.
const cancelWatchdogGrace = 5 * time.Second

// Cancel stops a running agent loop. Returns true if a run was found and
// cancelled. Cancel is a contract: within cancelWatchdogGrace of this call
// the desktop sees a terminal engine_status idle event regardless of whether
// the run goroutine has actually returned. If the goroutine is wedged in a
// blocking call that ignores ctx, the run state is force-cleared anyway and
// the wedged goroutine is leaked until process exit.
func (b *ApiBackend) Cancel(requestID string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	numRuns := len(b.activeRuns)
	b.mu.Unlock()

	if !ok {
		utils.Warn("ApiBackend", fmt.Sprintf("Cancel: requestID=%s not found in activeRuns (have %d runs)", requestID, numRuns))
		return false
	}
	utils.Info("ApiBackend", fmt.Sprintf("Cancel: cancelling requestID=%s (turn=%d)", requestID, run.turnCount.Load()))
	run.cancel()
	go b.cancelWatchdog(run, cancelWatchdogGrace)
	return true
}

// cancelWatchdog force-clears a run if its goroutine has not returned within
// the grace period. Idempotent against runLoop's own deferred removeRun.
func (b *ApiBackend) cancelWatchdog(run *activeRun, grace time.Duration) {
	timer := time.NewTimer(grace)
	defer timer.Stop()
	<-timer.C

	b.mu.Lock()
	_, stillActive := b.activeRuns[run.requestID]
	sessionID := ""
	if run.conv != nil {
		sessionID = run.conv.ID
	}
	b.mu.Unlock()
	if !stillActive {
		return
	}

	utils.Warn("ApiBackend", fmt.Sprintf("Cancel watchdog: forcing exit for requestID=%s after %s (run goroutine wedged in non-cancellable call)", run.requestID, grace))
	b.emitExit(run.requestID, intPtr(0), strPtr("cancelled-forced"), sessionID)
	b.removeRun(run.requestID)
}

// GetContextUsage returns the context usage for an active run, or nil if not found.
func (b *ApiBackend) GetContextUsage(requestID string) *conversation.ContextUsageInfo {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run.conv == nil {
		return nil
	}
	model := run.conv.Model
	contextWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil {
		contextWindow = info.ContextWindow
	}
	usage := conversation.GetContextUsage(run.conv, contextWindow)
	return &usage
}

// Steer sends a steering message to an active run's conversation.
func (b *ApiBackend) Steer(requestID, message string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case run.steerCh <- message:
		return true
	default:
		return false // channel full
	}
}

// WriteToStdin is a no-op for ApiBackend. The API backend uses conversation
// injection (Steer) rather than stdin pipes.
func (b *ApiBackend) WriteToStdin(_ string, _ interface{}) error {
	return nil
}

// IsRunning reports whether a run is currently active.
func (b *ApiBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.activeRuns[requestID]
	return ok
}

func (b *ApiBackend) removeRun(requestID string) {
	b.mu.Lock()
	delete(b.activeRuns, requestID)
	b.mu.Unlock()
}

// emit forwards a normalized event to the registered onNormalized callback
// (set once by the server). The redaction policy comes from the run's own
// SecurityCfg so concurrent runs with different configs don't leak.
func (b *ApiBackend) emit(run *activeRun, event types.NormalizedEvent) {
	if run != nil && run.cfg != nil && run.cfg.SecurityCfg != nil && run.cfg.SecurityCfg.RedactSecrets {
		if tr, ok := event.Data.(*types.ToolResultEvent); ok {
			tr.Content = insights.RedactSecrets(tr.Content)
			tr.Content = insights.MaskSensitiveFields(tr.Content)
		}
	}
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		runID := ""
		if run != nil {
			runID = run.requestID
		}
		fn(runID, event)
	}
}

func (b *ApiBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.Info("ApiBackend", fmt.Sprintf("emitExit: runID=%s code=%s signal=%s sessionID=%s", runID, codeStr, sigStr, sessionID))
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *ApiBackend) emitError(run *activeRun, err error) {
	runID := ""
	if run != nil {
		runID = run.requestID
	}
	utils.Error("ApiBackend", fmt.Sprintf("emitError: runID=%s err=%s", runID, err.Error()))

	// Emit structured error through the normalized event pipeline so it
	// reaches all clients and extension hooks with full classification.
	errEvent := &types.ErrorEvent{
		ErrorMessage: err.Error(),
		IsError:      true,
	}
	if pe, ok := err.(*providers.ProviderError); ok {
		errEvent.ErrorCode = pe.Code
		errEvent.HttpStatus = pe.HTTPStatus
		errEvent.Retryable = pe.Retryable
		errEvent.RetryAfterMs = pe.RetryAfterMs
	}
	b.emit(run, types.NormalizedEvent{Data: errEvent})

	// Still call onError callback for logging coordination
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

// contextPercent computes the compaction threshold.
const compactThreshold = 80

// runHookCtx runs fn on a goroutine and races it against ctx cancellation.
// On cancel, returns ctx.Err() and discards the eventual result. The inner
// goroutine continues to completion (it has no way to be cancelled — that's
// why we need this wrapper) but its return value is dropped. Use to bound
// per-tool extension hooks (OnToolCall, OnPermissionRequest, etc.) that are
// implemented by extension subprocesses with no native ctx support.
func runHookCtx[T any](ctx context.Context, fn func() T) (T, error) {
	var zero T
	ch := make(chan T, 1)
	go func() {
		defer func() {
			// Hook callbacks are extension-supplied; recover panics so they
			// can't take down the run. Drop the result on panic.
			recover()
		}()
		ch <- fn()
	}()
	select {
	case v := <-ch:
		return v, nil
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}

// defaultToolTimeout caps how long a single tool call may run. The cap is a
// belt-and-suspenders backstop against tools that ignore ctx; properly
// cooperating tools cancel via gCtx far sooner. Bash has its own much-longer
// inner timeout (long shell commands are legitimate); this cap applies to the
// surrounding goroutine, so a misbehaving Bash subprocess that ignores SIGTERM
// will still let executeTools return.
const defaultToolTimeout = 5 * time.Minute

// toolStallThreshold is how long a tool call runs before a ToolStalledEvent
// is emitted. This is a heuristic to surface tools that may be blocked by
// macOS TCC permission dialogs or stuck on slow operations. The event is
// informational -- it does NOT cancel the tool.
//
// Declared as a var (not const) so tests can shorten it without waiting 30s.
var toolStallThreshold = 30 * time.Second

// runLoop is the core agent loop. It calls the provider, processes the
// response, executes tools, and loops until the model signals end_turn,
// the budget is exceeded, or the context is cancelled.
func (b *ApiBackend) runLoop(ctx context.Context, run *activeRun, opts types.RunOptions) {
	defer b.removeRun(run.requestID)

	// Snapshot per-run hooks once. Nil cfg means "no hooks" -- the empty
	// RunHooks struct has nil callback fields, which the call sites below
	// already guard against.
	var hooks RunHooks
	if run.cfg != nil {
		hooks = run.cfg.Hooks
	}

	// Resolve provider
	model := opts.Model
	if model == "" {
		msg := "no model configured: set defaultModel in ~/.ion/engine.json or pass --model. See docs/configuration/engine-json.md."
		utils.Error("ApiBackend", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "no_model_configured",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}

	// Resolve API key via auth resolver and inject into environment
	b.mu.Lock()
	authRes := b.authResolver
	b.mu.Unlock()
	if authRes != nil {
		providerName := providers.ProviderNameForModel(model)
		if providerName != "" {
			if key, err := authRes.ResolveKey(providerName); err == nil && key != "" {
				providers.SetProviderKey(providerName, key)
			}
		}
	}

	provider := providers.ResolveProvider(model)
	if provider == nil {
		utils.Error("ApiBackend", fmt.Sprintf("no provider for model %q", model))
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf("no provider found for model %q", model),
			ErrorCode:    "invalid_model",
		}})
		b.emitError(run, fmt.Errorf("no provider found for model %q", model))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}

	// Load or create conversation
	var conv *conversation.Conversation
	if opts.SessionID != "" {
		loaded, err := conversation.Load(opts.SessionID, "")
		if err != nil {
			utils.Log("ApiBackend", "creating new conversation: "+opts.SessionID)
			conv = conversation.CreateConversation(opts.SessionID, opts.SystemPrompt, model)
		} else {
			// Sanitize loaded messages (fix orphaned tool_result blocks, remove thinking)
			loaded.Messages = conversation.SanitizeMessages(loaded.Messages)
			conv = loaded
		}
	} else {
		// Append a 6-byte random suffix so two runs that begin in the same
		// millisecond cannot collide on the conversation file. Falls back to
		// a counter on the (extremely unlikely) rand.Read failure.
		conv = conversation.CreateConversation(
			fmt.Sprintf("%d-%s", time.Now().UnixMilli(), newConvSuffix()),
			opts.SystemPrompt,
			model,
		)
	}
	run.conv = conv

	// Build system prompt
	systemPrompt := conv.System
	if opts.SystemPrompt != "" {
		systemPrompt = opts.SystemPrompt
	}
	if opts.AppendSystemPrompt != "" {
		systemPrompt += "\n\n" + opts.AppendSystemPrompt
	}
	if opts.PlanMode {
		// Check extension hook for custom plan mode prompt
		planPrompt := opts.PlanModePrompt
		if planPrompt == "" && hooks.OnPlanModePrompt != nil {
			customPrompt, customTools := hooks.OnPlanModePrompt(opts.PlanFilePath)
			if customPrompt != "" {
				planPrompt = customPrompt
			}
			if customTools != nil {
				opts.PlanModeTools = customTools
			}
		}
		if planPrompt == "" {
			// Use default plan mode prompt
			_, err := os.Stat(opts.PlanFilePath)
			planPrompt = buildPlanModePrompt(opts.PlanFilePath, err == nil)
		}
		systemPrompt += "\n\n" + planPrompt
	}
	// Fire before_prompt hook (before finalizing system prompt)
	if hooks.OnBeforePrompt != nil {
		rewrittenPrompt, extraSystem := hooks.OnBeforePrompt(run.requestID, opts.Prompt)
		if rewrittenPrompt != "" {
			opts.Prompt = rewrittenPrompt
		}
		if extraSystem != "" {
			systemPrompt += "\n\n" + extraSystem
		}
	}

	// Add capability prompt
	if opts.CapabilityPrompt != "" {
		systemPrompt += "\n" + opts.CapabilityPrompt
	}

	// Finalize system prompt (after all hook contributions)
	conv.System = systemPrompt

	// Add user message (using potentially-rewritten prompt)
	conversation.AddUserMessage(conv, opts.Prompt)
	// Persist immediately: if the engine dies mid-stream, the user prompt
	// must survive so the user does not lose what they just typed.
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save conversation after AddUserMessage: "+err.Error())
	}

	// Resolve limits. Engine ships unopinionated: maxTurns/maxBudget <= 0 means
	// "no cap" -- the agent loop runs until the LLM emits a terminal stop or
	// the caller cancels. Harness engineers cap via RunOptions, engine.json
	// limits, or per-dispatch options.
	maxTurns := opts.MaxTurns
	maxBudget := opts.MaxBudgetUsd

	// Build tool definitions (built-in + external/MCP + capabilities)
	toolDefs := tools.GetToolDefs()
	var externalTools []types.LlmToolDef
	if run.cfg != nil {
		externalTools = run.cfg.ExternalTools
	}
	extToolCount := len(externalTools)
	if extToolCount > 0 {
		toolDefs = append(toolDefs, externalTools...)
	}
	utils.Log("ApiBackend", fmt.Sprintf("tool count: builtin=%d external=%d total=%d", len(toolDefs)-extToolCount, extToolCount, len(toolDefs)))
	if len(opts.CapabilityTools) > 0 {
		toolDefs = append(toolDefs, opts.CapabilityTools...)
	}

	// Filter tools if plan mode and inject ExitPlanMode
	if opts.PlanMode {
		planTools := opts.PlanModeTools
		if len(planTools) == 0 {
			planTools = defaultPlanModeTools
		}
		allowed := make(map[string]bool, len(planTools)+2)
		for _, t := range planTools {
			allowed[t] = true
		}
		// Always allow Write/Edit so the LLM can write to the plan file
		// (plan-file-only gate in executeTools enforces the target restriction)
		allowed["Write"] = true
		allowed["Edit"] = true
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered

		// Always inject ExitPlanMode sentinel when in plan mode
		exitPlanDef := tools.ExitPlanModeTool()
		toolDefs = append(toolDefs, types.LlmToolDef{
			Name:        exitPlanDef.Name,
			Description: exitPlanDef.Description,
			InputSchema: exitPlanDef.InputSchema,
		})

		// Signal to the desktop that plan mode is now active for this run.
		b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true}})
		utils.Info("PlanMode", fmt.Sprintf("run=%s tools_filtered=%d allowed=%v", run.requestID, len(toolDefs), planTools))
	}

	// Filter by allowedTools if specified (empty list = no tools, nil = all tools)
	if opts.AllowedTools != nil {
		allowed := make(map[string]bool, len(opts.AllowedTools))
		for _, t := range opts.AllowedTools {
			allowed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// Filter out suppressed tools
	if len(opts.SuppressTools) > 0 {
		suppressed := make(map[string]bool, len(opts.SuppressTools))
		for _, t := range opts.SuppressTools {
			suppressed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if !suppressed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// When provider supports server-side web search, swap client WebSearch for server tool
	var serverTools []map[string]any
	providerID := provider.ID()
	if providerID == "anthropic" || providerID == "vertex" {
		filtered := toolDefs[:0]
		for _, td := range toolDefs {
			if td.Name != "WebSearch" {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
		serverTools = []map[string]any{{
			"type":     "web_search_20250305",
			"name":     "web_search",
			"max_uses": 5,
		}}
	}

	// Resolve context window for compaction checks
	contextWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil {
		contextWindow = info.ContextWindow
	}

	// Track consecutive prompt_too_long compaction failures to prevent infinite loops
	promptTooLongRetries := 0
	const maxPromptTooLongRetries = 3

	// Agent loop: turn increments at the top of each iteration (before
	// turn_start fires), so the first turn has turn=1. This matches the
	// TS reference where turnCount increments at the top of the while loop.
	// run.turnCount mirrors `turn` atomically so Cancel and other RPC paths
	// can read the latest value without taking run.mu.
	var turn int
	for maxTurns <= 0 || turn < maxTurns {
		if ctx.Err() != nil {
			utils.Warn("ApiBackend", fmt.Sprintf("run cancelled: runID=%s turns=%d cost=$%.4f", run.requestID, turn, run.totalCost))
			b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
			return
		}

		// Check for steer messages
		select {
		case steerMsg := <-run.steerCh:
			conversation.AddUserMessage(run.conv, steerMsg)
			if err := conversation.Save(run.conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after steer: "+err.Error())
			}
			utils.Log("ApiBackend", "steer message injected into conversation")
		default:
			// no steer message, continue normally
		}

		// Increment turn counter before firing turn_start, so the first turn
		// reports turn=1 (matching TS behavior).
		turn++
		run.turnCount.Store(int64(turn))

		// Wind-down: warn the LLM 2 turns before max so it can wrap up
		if maxTurns > 4 && turn == maxTurns-2 {
			conversation.AddUserMessage(run.conv, "[SYSTEM] You are approaching your turn limit. You have 2 turns remaining. Wrap up your current work, summarize what you've accomplished and what remains, then return your response.")
			if err := conversation.Save(run.conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after wind-down: "+err.Error())
			}
			utils.Log("ApiBackend", fmt.Sprintf("wind-down injected: runID=%s turn=%d/%d", run.requestID, turn, maxTurns))
		}

		// Fire turn_start hook
		if hooks.OnTurnStart != nil {
			hooks.OnTurnStart(run.requestID, turn)
		}

		// Check budget
		if maxBudget > 0 && run.totalCost >= maxBudget {
			utils.Warn("ApiBackend", fmt.Sprintf("budget exceeded: runID=%s cost=$%.4f budget=$%.4f", run.requestID, run.totalCost, maxBudget))
			b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
				ErrorMessage: fmt.Sprintf("budget exceeded: $%.4f >= $%.4f", run.totalCost, maxBudget),
				IsError:      true,
				ErrorCode:    "budget_exceeded",
			}})
			break
		}

		// Context compaction cascade at threshold (config override via opts.CompactThreshold)
		threshold := compactThreshold
		if opts.CompactThreshold > 0 {
			threshold = int(opts.CompactThreshold)
		}
		usage := conversation.GetContextUsage(conv, contextWindow)
		if usage.Percent > threshold {
			// Fire session_before_compact hook (can cancel)
			cancelCompact := false
			if hooks.OnSessionBeforeCompact != nil {
				cancelCompact = hooks.OnSessionBeforeCompact(run.requestID)
			}

			if !cancelCompact {
				b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
				msgBefore := len(conv.Messages)

				// Step 1: MicroCompact (tool results, then assistant text)
				cleared := conversation.MicroCompact(conv, 10)
				utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 1: was %d%%, micro-compact cleared %d", usage.Percent, cleared))

				// Step 2: if still above threshold, extract facts and hard-truncate
				usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
				if usageAfterMicro.Percent > threshold {
					facts := compaction.ExtractFacts(conv.Messages)
					conversation.Compact(conv, 10)
					if len(facts) > 0 {
						summary := compaction.FormatFactsSummary(facts)
						restoreMsg := compaction.PostCompactRestore(conv, compaction.ExtractRecentFiles(conv.Messages), nil)
						if summary != "" {
							factMsg := types.LlmMessage{
								Role: "user",
								Content: []types.LlmContentBlock{{
									Type: "text",
									Text: "[Extracted facts from compacted context]:\n" + summary,
								}},
							}
							conv.Messages = append([]types.LlmMessage{factMsg, restoreMsg}, conv.Messages...)
						}
					}
					utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 2: hard-truncated to %d messages", len(conv.Messages)))
				}

				b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false}})

				if hooks.OnSessionCompact != nil {
					hooks.OnSessionCompact(run.requestID, map[string]interface{}{
						"strategy":       "auto",
						"messagesBefore": msgBefore,
						"messagesAfter":  len(conv.Messages),
					})
				}
			}
		}

		// Build stream options (sanitize before each API call to catch orphaned tool blocks)
		streamOpts := types.LlmStreamOptions{
			Model:       model,
			System:      conv.System,
			Messages:    conversation.SanitizeMessages(conv.Messages),
			Tools:       toolDefs,
			ServerTools: serverTools,
		}
		if opts.MaxTokens > 0 {
			streamOpts.MaxTokens = opts.MaxTokens
		}
		if opts.Thinking != nil {
			streamOpts.Thinking = opts.Thinking
		}

		// Call provider with retry (with telemetry span)
		retryConfig := &providers.RetryConfig{
			MaxRetries:    opts.MaxRetries,
			FallbackModel: opts.FallbackModel,
			Persistent:    opts.Persistent,
		}

		var telem TelemetryCollector
		if run.cfg != nil {
			telem = run.cfg.Telemetry
		}
		var llmSpan Span
		if telem != nil {
			llmSpan = telem.StartSpan("llm.call", map[string]interface{}{
				"model": model,
				"turn":  turn,
			})
		}

		events, errc := providers.WithRetry(ctx, provider, streamOpts, retryConfig)

		// Process stream events
		assistantBlocks, stopReason, turnUsage, streamErr := b.processStream(ctx, run, events, errc)

		// End LLM telemetry span
		if llmSpan != nil {
			errStr := ""
			if streamErr != nil {
				errStr = streamErr.Error()
			}
			llmSpan.End(map[string]interface{}{"stopReason": stopReason}, errStr)
		}

		if streamErr != nil {
			if ctx.Err() != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("stream cancelled: runID=%s turn=%d", run.requestID, turn))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
			// G33: prompt_too_long / overloaded -- 3-step cascade then retry (capped)
			errMsg := streamErr.Error()
			if (strings.Contains(errMsg, "prompt_too_long") || strings.Contains(errMsg, "prompt is too long") ||
				strings.Contains(errMsg, "overloaded_error")) && turn > 0 {
				promptTooLongRetries++
				if promptTooLongRetries > maxPromptTooLongRetries {
					utils.Error("ApiBackend", fmt.Sprintf("prompt_too_long: %d retries exhausted, giving up: runID=%s", maxPromptTooLongRetries, run.requestID))
					b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
						ErrorMessage: fmt.Sprintf("Context too large after %d compaction attempts. Start a new conversation or manually reduce context.", maxPromptTooLongRetries),
						IsError:      true,
						ErrorCode:    "compaction_failed",
					}})
					b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
					return
				}

				// Fire session_before_compact hook (can cancel)
				if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
					utils.Log("ApiBackend", "reactive compaction cancelled by hook")
					continue // skip compaction, retry the turn as-is
				}

				b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
				utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long, compaction attempt %d/%d", promptTooLongRetries, maxPromptTooLongRetries))
				msgBefore := len(conv.Messages)

				// Step 1: micro-compact (tool results, then assistant text)
				cleared := conversation.MicroCompact(conv, 10)
				utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long micro-compact cleared %d blocks", cleared))

				// Step 2: fact extraction
				facts := compaction.ExtractFacts(conv.Messages)
				if len(facts) > 0 {
					summary := compaction.FormatFactsSummary(facts)
					restoreMsg := compaction.PostCompactRestore(conv, compaction.ExtractRecentFiles(conv.Messages), nil)
					if summary != "" {
						factMsg := types.LlmMessage{
							Role: "user",
							Content: []types.LlmContentBlock{{
								Type: "text",
								Text: "[Extracted facts from compacted context]:\n" + summary,
							}},
						}
						conv.Messages = append([]types.LlmMessage{factMsg, restoreMsg}, conv.Messages...)
					}
				}

				// Step 3: hard truncate -- use progressively smaller keepTurns on each retry
				keepTurns := 10 / promptTooLongRetries // 10, 5, 3
				conversation.Compact(conv, keepTurns)
				utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long hard-truncated to keepTurns=%d, %d messages remain", keepTurns, len(conv.Messages)))

				b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false}})

				// Fire session_compact hook (observe)
				if hooks.OnSessionCompact != nil {
					hooks.OnSessionCompact(run.requestID, map[string]interface{}{
						"strategy":       "reactive",
						"messagesBefore": msgBefore,
						"messagesAfter":  len(conv.Messages),
					})
				}
				continue // retry the turn after compaction
			}
			utils.Error("ApiBackend", fmt.Sprintf("stream error: runID=%s turn=%d err=%s", run.requestID, turn, streamErr.Error()))
			b.emitError(run, streamErr)
			b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
			return
		}

		// Stream succeeded -- reset compaction retry counter
		promptTooLongRetries = 0

		// Stream truncated (no stop reason) -- emit reset so desktop discards
		// partial text, then retry the turn.
		if stopReason == "" {
			utils.Warn("ApiBackend", fmt.Sprintf("stream truncated (no stop reason): runID=%s turn=%d, retrying", run.requestID, turn))
			b.emit(run, types.NormalizedEvent{Data: &types.StreamResetEvent{}})
			continue
		}

		// Track usage and cost
		if turnUsage != nil {
			costUsd := computeCost(model, *turnUsage)
			run.totalCost += costUsd
			conversation.UpdateCost(conv, costUsd)

			// Emit usage event with TOTAL input tokens (including cached) so
			// desktop shows accurate context percentage
			totalIn := turnUsage.InputTokens + turnUsage.CacheReadInputTokens + turnUsage.CacheCreationInputTokens
			outTok := turnUsage.OutputTokens
			cacheRead := turnUsage.CacheReadInputTokens
			cacheCreate := turnUsage.CacheCreationInputTokens
			b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
				Usage: types.UsageData{
					InputTokens:              &totalIn,
					OutputTokens:             &outTok,
					CacheReadInputTokens:     &cacheRead,
					CacheCreationInputTokens: &cacheCreate,
				},
			}})
		}

		// Add assistant message to conversation
		if len(assistantBlocks) > 0 {
			var llmUsage types.LlmUsage
			if turnUsage != nil {
				llmUsage = *turnUsage
			}
			conversation.AddAssistantMessage(conv, assistantBlocks, llmUsage)
			// Persist immediately so the assistant turn survives mid-loop crashes.
			// The end-of-turn Save() below remains as the canonical write that
			// also captures stop-reason transitions.
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after AddAssistantMessage: "+err.Error())
			}
		}

		// Fire turn_end hook
		if hooks.OnTurnEnd != nil {
			hooks.OnTurnEnd(run.requestID, turn)
		}

		// Handle stop reason
		switch stopReason {
		case "end_turn", "stop":
			// Extract final text for task_complete
			var resultText string
			for _, block := range assistantBlocks {
				if block.Type == "text" {
					resultText += block.Text
				}
			}

			// Save conversation
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
			}

			elapsed := time.Since(run.startTime).Milliseconds()
			utils.Info("ApiBackend", fmt.Sprintf("run complete: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, turn, run.totalCost, elapsed, conv.ID))
			b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Result:     resultText,
				CostUsd:    run.totalCost,
				DurationMs: elapsed,
				NumTurns:   turn,
				SessionID:  conv.ID,
			}})
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return

		case "tool_use":
			// Extract tool_use blocks
			var toolUseBlocks []types.LlmContentBlock
			for _, block := range assistantBlocks {
				if block.Type == "tool_use" {
					toolUseBlocks = append(toolUseBlocks, block)
				}
			}

			if len(toolUseBlocks) == 0 {
				// No tool calls despite tool_use stop reason; treat as end_turn
				continue
			}

			// Execute tools in parallel
			results, err := b.executeTools(ctx, run, toolUseBlocks, opts.ProjectPath)
			if err != nil {
				if ctx.Err() != nil {
					utils.Warn("ApiBackend", fmt.Sprintf("tool execution cancelled: runID=%s", run.requestID))
					b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
					return
				}
				utils.Error("ApiBackend", fmt.Sprintf("tool execution failed: runID=%s err=%s", run.requestID, err.Error()))
				b.emitError(run, err)
				b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
				return
			}

			// Check for cancellation even when tools completed successfully.
			// Tool goroutines return nil unconditionally, so executeTools may
			// return (results, nil) even after the context was cancelled.
			// Without this check the loop would add results and start a new
			// LLM turn before noticing the abort at the top of the loop.
			if ctx.Err() != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("run cancelled after tool execution: runID=%s", run.requestID))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}

			// If ExitPlanMode was triggered, wrap up the run now.
			run.mu.Lock()
			exiting := run.exitPlanMode
			denials := run.permissionDenials
			run.mu.Unlock()
			if exiting {
				if err := conversation.Save(conv, ""); err != nil {
					utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
				}
				elapsed := time.Since(run.startTime).Milliseconds()
				utils.Info("ApiBackend", fmt.Sprintf("plan mode exited: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, turn, run.totalCost, elapsed, conv.ID))
				b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
					Result:            "Plan mode exited.",
					CostUsd:           run.totalCost,
					DurationMs:        elapsed,
					NumTurns:          turn,
					SessionID:         conv.ID,
					PermissionDenials: denials,
				}})
				b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
				return
			}

			// Add tool results to conversation
			conversation.AddToolResults(conv, results)
			// Persist immediately so tool history survives mid-multi-turn crashes.
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after AddToolResults: "+err.Error())
			}

		case "max_tokens":
			utils.Info("ApiBackend", fmt.Sprintf("max_tokens reached, continuing: runID=%s turn=%d", run.requestID, turn))
			// Add continue message and loop
			conversation.AddUserMessage(conv, "Continue from where you left off.")
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after max_tokens continue: "+err.Error())
			}

		default:
			// Unknown stop reason; break the loop
			utils.Log("ApiBackend", "unexpected stop reason: "+stopReason)
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return
		}
	}

	// Exceeded max turns
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
	}

	elapsed := time.Since(run.startTime).Milliseconds()
	b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Result:     fmt.Sprintf("Reached max turns (%d)", maxTurns),
		CostUsd:    run.totalCost,
		DurationMs: elapsed,
		NumTurns:   turn,
		SessionID:  conv.ID,
	}})
	utils.Warn("ApiBackend", fmt.Sprintf("max turns exceeded: runID=%s turns=%d/%d cost=$%.4f", run.requestID, turn, maxTurns, run.totalCost))
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// processStream consumes LLM stream events, emits normalized events, and
// returns the collected assistant content blocks, stop reason, and usage.
func (b *ApiBackend) processStream(
	ctx context.Context,
	run *activeRun,
	events <-chan types.LlmStreamEvent,
	errc <-chan error,
) ([]types.LlmContentBlock, string, *types.LlmUsage, error) {

	var assistantBlocks []types.LlmContentBlock
	var currentBlockIndex int
	var currentPartialJSON strings.Builder
	var stopReason string
	var cumUsage types.LlmUsage
	var toolCallIndex int

	for ev := range events {
		if ctx.Err() != nil {
			return nil, "", nil, ctx.Err()
		}

		switch ev.Type {
		case "message_start":
			if ev.MessageInfo != nil {
				cumUsage = ev.MessageInfo.Usage
				// Emit cache token counts so clients see them immediately
				// (TS emits cache_read from message_start).
				if cumUsage.CacheReadInputTokens > 0 || cumUsage.CacheCreationInputTokens > 0 {
					cri := cumUsage.CacheReadInputTokens
					cci := cumUsage.CacheCreationInputTokens
					b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
						Usage: types.UsageData{
							CacheReadInputTokens:     &cri,
							CacheCreationInputTokens: &cci,
						},
					}})
				}
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			cb := ev.ContentBlock
			block := types.LlmContentBlock{
				Type:      cb.Type,
				ID:        cb.ID,
				Name:      cb.Name,
				Text:      cb.Text,
				ToolUseID: cb.ToolUseID,
			}
			// web_search_tool_result: serialize search results into Content string
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if raw, err := json.Marshal(cb.Content); err == nil {
					block.Content = string(raw)
				}
			}
			currentBlockIndex = ev.BlockIndex
			assistantBlocks = appendOrGrow(assistantBlocks, currentBlockIndex, block)

			if cb.Type == "tool_use" {
				b.emit(run, types.NormalizedEvent{Data: &types.ToolCallEvent{
					ToolName: cb.Name,
					ToolID:   cb.ID,
					Index:    toolCallIndex,
				}})
				toolCallIndex++
				currentPartialJSON.Reset()
			}

			// Server-side tool use (e.g. web_search) -- accumulate input JSON but don't execute locally
			if cb.Type == "server_tool_use" {
				currentPartialJSON.Reset()
			}

			// Server-side search results -- emit event for desktop rendering
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if results, ok := cb.Content.([]any); ok {
					var hits []types.WebSearchHit
					for _, r := range results {
						if m, ok := r.(map[string]any); ok {
							hit := types.WebSearchHit{}
							if t, ok := m["title"].(string); ok {
								hit.Title = t
							}
							if u, ok := m["url"].(string); ok {
								hit.URL = u
							}
							if hit.URL != "" {
								hits = append(hits, hit)
							}
						}
					}
					if len(hits) > 0 {
						b.emit(run, types.NormalizedEvent{Data: &types.WebSearchResultEvent{
							Results: hits,
						}})
					}
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			delta := ev.Delta

			if delta.Type == "text_delta" && delta.Text != "" {
				if currentBlockIndex < len(assistantBlocks) {
					assistantBlocks[currentBlockIndex].Text += delta.Text
				}
				b.emit(run, types.NormalizedEvent{Data: &types.TextChunkEvent{
					Text: delta.Text,
				}})
			}

			if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
				currentPartialJSON.WriteString(delta.PartialJSON)
				if currentBlockIndex < len(assistantBlocks) {
					toolID := assistantBlocks[currentBlockIndex].ID
					b.emit(run, types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{
						ToolID:       toolID,
						PartialInput: delta.PartialJSON,
					}})
				}
			}

		case "content_block_stop":
			// Parse accumulated tool input JSON (client or server tool).
			// On parse failure we coerce to an empty map and warn — the API
			// rejects messages whose tool_use.input is not a JSON object,
			// which would otherwise poison the conversation history forever.
			if currentBlockIndex < len(assistantBlocks) {
				block := &assistantBlocks[currentBlockIndex]
				if block.Type == "tool_use" || block.Type == "server_tool_use" {
					raw := currentPartialJSON.String()
					if raw == "" {
						block.Input = map[string]any{}
					} else {
						var input map[string]any
						if err := json.Unmarshal([]byte(raw), &input); err == nil {
							block.Input = input
						} else {
							preview := raw
							if len(preview) > 500 {
								preview = preview[:500] + "...(truncated)"
							}
							utils.Warn("ApiBackend", fmt.Sprintf("tool_use input parse failed (toolID=%s name=%s err=%v) coercing to {}: %s", block.ID, block.Name, err, preview))
							block.Input = map[string]any{}
						}
					}
					currentPartialJSON.Reset()
				}
			}

			b.emit(run, types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{
				Index: currentBlockIndex,
			}})

		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != nil {
				stopReason = *ev.Delta.StopReason
			}
			if ev.DeltaUsage != nil {
				// Accumulate final usage
				cumUsage.OutputTokens += ev.DeltaUsage.OutputTokens
			}
		}
	}

	// Check for stream error
	var streamErr error
	if errc != nil {
		streamErr = <-errc
	}

	return assistantBlocks, stopReason, &cumUsage, streamErr
}

// executeTools runs tool calls in parallel using errgroup.
func (b *ApiBackend) executeTools(
	ctx context.Context,
	run *activeRun,
	toolUseBlocks []types.LlmContentBlock,
	cwd string,
) ([]conversation.ToolResultEntry, error) {

	results := make([]conversation.ToolResultEntry, len(toolUseBlocks))
	g, gCtx := errgroup.WithContext(ctx)

	// All per-run configuration lives on run.cfg. Reading it without a lock
	// is safe because cfg is set once at StartRun and never mutated.
	var hooks RunHooks
	var permEng *permissions.Engine
	var sbCfg *sandbox.Config
	var mcpRouter func(string, map[string]interface{}) (string, bool, error)
	var telem TelemetryCollector
	var spawnerFn tools.AgentSpawner
	if run.cfg != nil {
		hooks = run.cfg.Hooks
		permEng = run.cfg.PermEngine
		sbCfg = run.cfg.SandboxCfg
		mcpRouter = run.cfg.McpToolRouter
		telem = run.cfg.Telemetry
		spawnerFn = run.cfg.AgentSpawner
	}
	hookFn := hooks.OnToolCall
	perToolHook := hooks.OnPerToolHook
	fileChangedFn := hooks.OnFileChanged
	permReqFn := hooks.OnPermissionRequest
	permDenyFn := hooks.OnPermissionDenied
	permClassifyFn := hooks.OnPermissionClassify

	// Inject session-scoped agent spawner into context for Agent tool
	if spawnerFn != nil {
		gCtx = tools.WithAgentSpawner(gCtx, spawnerFn)
	}

	for i, block := range toolUseBlocks {
		i, block := i, block
		g.Go(func() error {
			// Permission check (Step 3)
			if permEng != nil {
				// Classify first so the tier flows into the permission engine
				// (for tier_rules matching) and onto the permission_request
				// hook payload (for audit/observation). The classifier may
				// invoke an LLM, so race against gCtx so a hung classifier
				// can't wedge this goroutine.
				var tier string
				if permClassifyFn != nil {
					t, hookErr := runHookCtx(gCtx, func() string {
						return permClassifyFn(block.Name, block.Input)
					})
					if hookErr != nil {
						return hookErr
					}
					tier = t
				}
				checkResult := permEng.Check(permissions.CheckInfo{
					Tool:  block.Name,
					Input: block.Input,
					Cwd:   cwd,
					Tier:  tier,
				})
				if permReqFn != nil {
					payload := map[string]interface{}{
						"tool_name": block.Name,
						"input":     block.Input,
						"decision":  checkResult.Decision,
					}
					if tier != "" {
						payload["tier"] = tier
					}
					if _, hookErr := runHookCtx(gCtx, func() struct{} {
						permReqFn(run.requestID, payload)
						return struct{}{}
					}); hookErr != nil {
						return hookErr
					}
				}
				if checkResult.Decision == "deny" {
					if permDenyFn != nil {
						if _, hookErr := runHookCtx(gCtx, func() struct{} {
							permDenyFn(run.requestID, map[string]interface{}{
								"tool_name": block.Name,
								"input":     block.Input,
								"reason":    checkResult.Reason,
							})
							return struct{}{}
						}); hookErr != nil {
							return hookErr
						}
					}
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Permission denied: " + checkResult.Reason,
						IsError:   true,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: results[i].Content,
						IsError: true,
					}})
					return nil
				}
			}

			// Sandbox validation for Bash tool (Step 3)
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					safe, reason := sandbox.ValidateWithConfig(cmd, *sbCfg)
					if !safe {
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   "Sandbox blocked: " + reason,
							IsError:   true,
						}
						b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: results[i].Content,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// After sandbox validation passes, wrap if sandbox config exists
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					if wrapped, err := sandbox.WrapCommand(cmd, *sbCfg, ""); err == nil && wrapped != cmd {
						block.Input["command"] = wrapped
					}
				}
			}

			// Call onToolCall hook (extension hook). Race against gCtx so a
			// hung extension subprocess can't wedge this goroutine; the run's
			// per-tool 5min timeout is the outer backstop.
			if hookFn != nil {
				type hookRet struct {
					result *ToolCallResult
					err    error
				}
				ret, hookErr := runHookCtx(gCtx, func() hookRet {
					r, e := hookFn(ToolCallInfo{
						ToolName: block.Name,
						ToolID:   block.ID,
						Input:    block.Input,
					})
					return hookRet{r, e}
				})
				if hookErr != nil {
					return hookErr
				}
				result, err := ret.result, ret.err
				if err != nil {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Hook error: " + err.Error(),
						IsError:   true,
					}
					return nil
				}
				if result != nil && result.Block {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Blocked: " + result.Reason,
						IsError:   true,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: "Blocked: " + result.Reason,
						IsError: true,
					}})
					return nil
				}
			}

			// Pre-tool hook
			if perToolHook != nil {
				if _, hookErr := runHookCtx(gCtx, func() struct{} {
					_, _ = perToolHook(block.Name, block.Input, "before")
					return struct{}{}
				}); hookErr != nil {
					return hookErr
				}
			}

			// Telemetry span for tool execution
			var toolSpan Span
			if telem != nil {
				toolSpan = telem.StartSpan("tool.execute", map[string]interface{}{
					"tool": block.Name,
				})
			}

			// Plan mode write gate: only the plan file is writable.
			if run.planMode && (block.Name == "Write" || block.Name == "Edit") {
				if targetPath, ok := block.Input["file_path"].(string); ok {
					if targetPath != run.planFilePath {
						utils.Info("PlanMode", fmt.Sprintf("run=%s blocked=%s target=%s plan_file=%s", run.requestID, block.Name, targetPath, run.planFilePath))
						msg := fmt.Sprintf("Plan mode: cannot write to %s. Only the plan file (%s) is writable.", targetPath, run.planFilePath)
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   msg,
							IsError:   true,
						}
						b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: msg,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// Intercept ExitPlanMode sentinel — only during plan-mode runs.
			// In auto mode the LLM may hallucinate this call from conversation
			// history; let it fall through to "Unknown tool" so it self-corrects.
			if run.planMode && block.Name == tools.ExitPlanModeName {
				utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool plan_file=%s", run.requestID, run.planFilePath))
				run.mu.Lock()
				run.exitPlanMode = true
				run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
					ToolName:  block.Name,
					ToolUseID: block.ID,
					ToolInput: map[string]any{"planFilePath": run.planFilePath},
				})
				run.mu.Unlock()
				// Signal to the desktop that plan mode is now exiting.
				b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: false, PlanFilePath: run.planFilePath}})
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Plan mode exited.",
					IsError:   false,
				}
				b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
					ToolID:  block.ID,
					Content: "Plan mode exited.",
					IsError: false,
				}})
				return nil
			}

			// Stall detection: emit ToolStalledEvent if the tool hasn't
			// returned within the stall threshold. Informational only.
			toolDone := make(chan struct{})
			go func() {
				stallTimer := time.NewTimer(toolStallThreshold)
				defer stallTimer.Stop()
				select {
				case <-stallTimer.C:
					b.emit(run, types.NormalizedEvent{Data: &types.ToolStalledEvent{
						ToolID:   block.ID,
						ToolName: block.Name,
						Elapsed:  toolStallThreshold.Seconds(),
					}})
				case <-toolDone:
					// Tool finished before stall threshold; nothing to do.
				}
			}()

			// Route to built-in, extension, or MCP tool (Step 5).
			// Each tool call is bounded by defaultToolTimeout. A tool that
			// observes ctx will cancel cleanly; a tool that ignores ctx will
			// be left running but its result is dropped, and executeTools
			// returns once errgroup's children all return.
			toolCtx, toolCancel := context.WithTimeout(gCtx, defaultToolTimeout)
			defer toolCancel()

			var toolResult *types.ToolResult
			var err error

			if tools.GetTool(block.Name) != nil {
				toolResult, err = tools.ExecuteTool(toolCtx, block.Name, block.Input, cwd)
			} else if mcpRouter != nil {
				// mcpRouter does not yet take ctx; race its return against
				// toolCtx so a hung MCP server cannot wedge the run.
				type mcpRet struct {
					content string
					isErr   bool
					err     error
				}
				resCh := make(chan mcpRet, 1)
				go func() {
					content, isErr, routeErr := mcpRouter(block.Name, block.Input)
					resCh <- mcpRet{content, isErr, routeErr}
				}()
				select {
				case r := <-resCh:
					if r.err != nil {
						err = r.err
					} else {
						toolResult = &types.ToolResult{Content: r.content, IsError: r.isErr}
					}
				case <-toolCtx.Done():
					err = toolCtx.Err()
				}
			} else {
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Unknown tool: %s", block.Name),
					IsError: true,
				}
			}

			// Surface per-tool deadline as a tool-result error rather than
			// failing the whole run, so the LLM sees a clear "this tool timed
			// out" message and can adapt.
			if err != nil && toolCtx.Err() == context.DeadlineExceeded {
				err = nil
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Error: tool %q exceeded %s deadline. Narrow the request or split it into smaller calls.", block.Name, defaultToolTimeout),
					IsError: true,
				}
			}

			// Signal stall timer that the tool has completed.
			close(toolDone)

			// End tool span
			if toolSpan != nil {
				errStr := ""
				if err != nil {
					errStr = err.Error()
				}
				toolSpan.End(nil, errStr)
			}

			if err != nil {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Error: " + err.Error(),
					IsError:   true,
				}
			} else {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   toolResult.Content,
					IsError:   toolResult.IsError,
				}
			}

			// Fire file_changed hook for write/edit tools
			if fileChangedFn != nil && !results[i].IsError {
				var p string
				var changeKind string
				switch block.Name {
				case "Write", "write":
					if v, ok := block.Input["file_path"].(string); ok {
						p, changeKind = v, "write"
					}
				case "Edit", "edit":
					if v, ok := block.Input["file_path"].(string); ok {
						p, changeKind = v, "edit"
					}
				}
				if p != "" {
					if _, hookErr := runHookCtx(gCtx, func() struct{} {
						fileChangedFn(run.requestID, p, changeKind)
						return struct{}{}
					}); hookErr != nil {
						return hookErr
					}
				}
			}

			// Post-tool hook
			if perToolHook != nil {
				if _, hookErr := runHookCtx(gCtx, func() struct{} {
					_, _ = perToolHook(block.Name, results[i], "after")
					return struct{}{}
				}); hookErr != nil {
					return hookErr
				}
			}

			// Emit tool_result event
			b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: results[i].Content,
				IsError: results[i].IsError,
			}})

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}

// computeCost estimates the USD cost for a turn using the model registry.
func computeCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		return 0
	}
	inputCost := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	outputCost := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput
	return inputCost + outputCost
}

// appendOrGrow ensures the slice is large enough for the given index.
func appendOrGrow(blocks []types.LlmContentBlock, idx int, block types.LlmContentBlock) []types.LlmContentBlock {
	for len(blocks) <= idx {
		blocks = append(blocks, types.LlmContentBlock{})
	}
	blocks[idx] = block
	return blocks
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }
