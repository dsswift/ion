package backend

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/insights"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

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
	// planModeSparseReminderOverride is the harness-supplied sparse reminder text
	// resolved once at run setup from RunOptions.PlanModeSparseReminder (highest
	// priority) or the plan_mode_prompt hook's SparseReminder return field.
	// Empty means "use buildPlanModeSparseReminder at injection time" (the
	// engine default). Set in runloop_setup.go alongside planFilePath.
	planModeSparseReminderOverride string
	// planModeReminderTurn is the turn number on which the sparse plan-mode
	// reminder last fired. The reminder is throttled to once per
	// planModeReminderInterval turns to avoid the ~per-tool-round churn that
	// previously anchored AskUserQuestion-as-turn-ender behavior in the model.
	// Reset to 0 whenever a run re-enters plan mode via the EnterPlanMode
	// sentinel so the throttle does not silence the first post-entry reminder.
	planModeReminderTurn int
	// planModeAllowedBashCommands is the set of command prefixes that the
	// Bash tool is allowed to execute during plan mode. When non-empty,
	// Bash is included in the plan-mode tool list but gated at execution
	// time — only commands whose leading token(s) match one of these
	// prefixes are permitted. Set from RunOptions.PlanModeAllowedBashCommands
	// in buildToolDefs.
	planModeAllowedBashCommands []string

	// planModeAutoExitEnabled records the effective auto-exit setting for
	// this run, resolved at run setup from (in precedence order):
	//   1. RunOptions.PlanModeAutoExit (per-run pointer)
	//   2. LimitsConfig.PlanModeAutoExitOnEndTurn (engine.json)
	//   3. Built-in default (true)
	//
	// When false, the end-of-turn synthesis safety net is disabled and a
	// plan-mode run that ends without an ExitPlanMode / AskUserQuestion
	// tool call completes as a normal end_turn with the conversation
	// parked in plan mode (today's behaviour pre-#187).
	//
	// The before_plan_mode_auto_exit hook can still suppress synthesis
	// even when this is true; the hook runs last in the precedence chain.
	planModeAutoExitEnabled bool

	// opts captures the RunOptions for this run so compaction (and other
	// cross-turn logic) can read config-driven knobs without plumbing opts
	// through every internal call. Set once in StartRunWithConfig.
	opts *types.RunOptions

	// compactionsWithoutProgress counts proactive compactions that have fired
	// without an intervening successful API response. Bounds the cascade if
	// the conversation cannot be shrunk below the trigger limit so the run
	// surfaces an error instead of looping.
	compactionsWithoutProgress int

	// Early-stop continuation bookkeeping. See runloop_early_stop.go for
	// the decision logic and runloop.go for the integration into the
	// end_turn / stop branch of the agent loop.
	//
	// continuationCount is the number of times the engine has already
	// nudged the model on this run. Reset on non-stop outcomes (tool_use,
	// max_tokens) so multi-step tool work doesn't accidentally consume the
	// cap. cumulativeOutputTokens is the total across every turn, including
	// the one that just ended. lastContinuationDelta is the delta from the
	// previous continuation; the diminishing-returns guard reads it.
	continuationCount      int
	cumulativeOutputTokens int
	lastContinuationDelta  int

	// contextBreakdown holds the per-category token breakdown built once at
	// the first turn's prompt assembly. Reconciled (and re-emitted) after the
	// first UsageEvent so consumers see the provider-reported total and the
	// unaccounted delta. Nil until the first turn builds it; breakdownReconciled
	// guards the one-shot reconcile so later turns don't append duplicate
	// "unaccounted" rows.
	contextBreakdown    *providers.ContextBreakdown
	breakdownReconciled bool

	// Cumulative token counters across all turns. Populated on the same
	// path that accumulates run.totalCost (turnUsage in the runloop).
	// Surfaced on every TaskCompleteEvent.Usage so dispatch consumers
	// and any event reader gets real token counts.
	cumulativeInputTokens        int
	cumulativeCacheReadTokens    int
	cumulativeCacheCreateTokens  int

	// thinkingTokens accumulates the estimated reasoning-token count across
	// every thinking block in this run (issue #158). Providers fold thinking
	// into the final output-token usage, so this is an estimate derived from
	// accumulated reasoning text length (see ThinkingBlockEndEvent.TotalTokens).
	// Surfaced on DispatchAgentResult.ThinkingTokens / engine_dispatch_end so
	// cost/audit consumers can separate reasoning spend from user-facing
	// output. Atomic because processStream runs on the run goroutine while the
	// dispatch result is assembled after the run completes — the value is read
	// once the run goroutine has finished, but atomic keeps it race-free under
	// the detector regardless of read/write ordering.
	thinkingTokens atomic.Int64

	// lastProgressAt is the unix-nanos timestamp of the last observed
	// forward-progress event on this run. Bumped on every emit (so
	// every provider stream chunk, tool result, status update, error
	// event, etc.) and explicitly at every turn boundary. The
	// run-progress watchdog goroutine launched in StartRunWithConfig
	// reads this atomically every watchdog tick (default 30s) and
	// cancels the run if (now - lastProgressAt) > RunStall().
	//
	// Atomic so the watchdog goroutine can read without taking
	// run.mu — that mutex protects unrelated fields and is held for
	// non-trivial durations during conversation save/load paths.
	// Storing nanos as int64 keeps the value lock-free with the
	// std/sync/atomic primitives.
	lastProgressAt atomic.Int64

	// humanWaitDepth counts how many human-wait spans this run is currently
	// blocked inside. A human-wait is an *intentional* indefinite pause for a
	// user decision. The only producer is Manager.elicit (ctx.elicit()); a
	// permission decision on this (the watchdog-bearing ApiBackend) is
	// synchronous (permEng.Check returns a policy decision and does not block
	// on a human), and the blocking permission dialog (PermissionHookServer)
	// runs only on the CLI backend, which has no watchdog — so neither needs
	// this exemption. The exemption exists for elicitation, as opposed to a
	// wedged tool or stalled provider stream. While depth > 0 the run-progress
	// watchdog (runloop_watchdog.go) must NOT cancel the run for idleness,
	// because zero forward-progress emits during a human-wait is the expected,
	// contract-mandated state, not a stall.
	//
	// The default human-wait is indefinite (see TimeoutsConfig.HumanWait): if a
	// user takes a month to approve a plan, the run waits a month. The watchdog
	// is the only mechanism that previously violated that guarantee — it had no
	// human-wait exemption and cancelled the parked run at RunStall() (10m). This
	// counter is that exemption.
	//
	// A counter (not a bool) so genuinely overlapping or nested waits — e.g. an
	// extension elicitation_request hook that itself elicits while the
	// triggering tool's ctx.elicit() is still open — are reference-counted
	// correctly: the watchdog resumes only when the LAST wait ends. Bumped via
	// ApiBackend.BeginHumanWait / EndHumanWait. Atomic so the watchdog goroutine
	// reads it without taking run.mu, matching lastProgressAt.
	humanWaitDepth atomic.Int64

	// progressWatchdogStop is closed by runLoop's deferred removeRun
	// to signal the run-progress watchdog goroutine that it should
	// exit immediately rather than wait up to one tick for its
	// activeRuns-map poll to notice the run ended. Without this
	// channel the watchdog goroutine lingers for up to
	// runProgressWatchdogTick (default 30s) after every run
	// completes — fine in production but a goroutine leak in tests
	// and a real concern during FlushConversations / process
	// shutdown which expects goroutines to drain promptly.
	//
	// Closed exactly once via sync.Once-equivalent semantics: the
	// stopWatchdogOnce field guards the close so accidental
	// double-close (from race-prone teardown paths) does not panic.
	progressWatchdogStop chan struct{}
	stopWatchdogOnce     sync.Once

	// touchedSink accumulates filesystem paths that tools touched during the
	// run, driving read-triggered nested context loading (progressive
	// AGENTS.md/ION.md descent). Tools record into it via the ctx-threaded
	// TouchedPathSink (installed in executeTools); the run loop drains it
	// between turns in drainNestedContext. The sink has its own mutex, so the
	// write path (concurrent errgroup tool goroutines) does not take run.mu.
	// Created once at run start.
	touchedSink *types.TouchedPathSink

	// injectedNestedPaths is the conversation-lifetime set of context-file
	// paths already injected into this conversation (eager root/home walk +
	// any nested injections, this session or a prior one). Guarded by run.mu.
	// Seeded at run start from the loaded conversation (system prompt + message
	// history) via seedInjectedNestedPaths so a reload never re-injects a file
	// that is already present. drainNestedContext consults and extends it.
	injectedNestedPaths map[string]bool

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

	// lastRunConfig caches the RunConfig from the most recent
	// StartRunWithConfig call so out-of-run operations (CompactNow,
	// triggered by /compact between turns) can replay the session's
	// hooks, session-memory helpers, and security config without
	// constructing them from scratch.
	//
	// Guarded by mu. A nil value means "no run has started on this
	// backend instance yet"; CompactNow falls back to a zero-valued
	// RunConfig in that case, which exercises the same code paths the
	// run loop uses when callers invoke StartRun (the no-hook path).
	lastRunConfig *RunConfig
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

// AuthResolver returns the currently-attached auth resolver, or nil if none
// has been set. Used by HybridBackend.NewChild to propagate the resolver to
// child backends when an ion_agent dispatch creates a fresh hybrid backend.
//
// Additive accessor — does not appear on the RunBackend interface and so
// does not affect contract stability.
func (b *ApiBackend) AuthResolver() *auth.Resolver {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.authResolver
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
	// Derive the run's cancellation context from the session root when the
	// caller threaded one (RunOptions.ParentCtx). This is what makes a
	// session-level abort cascade to this run: cancelling the session root
	// cancels parent, which cancels ctx here. Falls back to
	// context.Background() for callers that don't supply a parent (tests,
	// the Agent tool's child runs) — identical to the prior behavior.
	parent := options.ParentCtx
	if parent == nil {
		parent = context.Background()
		utils.Debug("ApiBackend", fmt.Sprintf("StartRunWithConfig: no ParentCtx; using Background runID=%s", requestID))
	} else {
		utils.Debug("ApiBackend", fmt.Sprintf("StartRunWithConfig: deriving run ctx from session ParentCtx runID=%s", requestID))
	}
	ctx, cancel := context.WithCancel(parent)

	run := &activeRun{
		requestID:    requestID,
		cancel:       cancel,
		startTime:    time.Now(),
		steerCh:      make(chan string, 4),
		planMode:     options.PlanMode,
		planFilePath: options.PlanFilePath,
		// Cache the RunOptions sparse-reminder override (highest precedence).
		// The plan_mode_prompt hook may also contribute a value later in
		// buildSystemPrompt; RunOptions wins so we set it unconditionally
		// and buildSystemPrompt only writes the hook value when this is empty.
		planModeSparseReminderOverride: options.PlanModeSparseReminder,
		planModeAutoExitEnabled:        resolvePlanModeAutoExit(&options, cfg),
		opts:                           &options,
		cfg:                            cfg,
		progressWatchdogStop:           make(chan struct{}),
	}
	// Seed the watchdog clock with "started just now". Without this the
	// watchdog's first tick (~30s in) would compare against the zero
	// timestamp and immediately flag the run as stalled. The agent loop
	// goroutine bumps this on every emit (see ApiBackend.emit) and at
	// every turn boundary (see runLoop).
	run.lastProgressAt.Store(run.startTime.UnixNano())

	utils.Info("ApiBackend", fmt.Sprintf("StartRunWithConfig: runID=%s model=%s sessionID=%s planMode=%v planModeAutoExit=%v", requestID, options.Model, options.SessionID, options.PlanMode, run.planModeAutoExitEnabled))

	b.mu.Lock()
	b.activeRuns[requestID] = run
	// Cache the RunConfig so CompactNow (invoked between turns when no
	// activeRun exists) can replay the session's hooks/memory helpers.
	// Captured under the same lock that owns activeRuns to avoid races
	// with a concurrent CompactNow read. nil cfg is allowed and stored
	// verbatim — the read path treats nil as "no hooks available".
	b.lastRunConfig = cfg
	b.mu.Unlock()

	go b.runLoop(ctx, run, options)
	// Run-progress watchdog: independent goroutine that cancels the run
	// if no emit lands within RunStall. Lives in runloop_watchdog.go.
	go b.runProgressWatchdog(run)
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
// consumers see a terminal engine_status idle event regardless of whether
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
	contextWindow := resolveContextWindow(model)
	usage := conversation.GetContextUsage(run.conv, contextWindow)
	return &usage
}

// GetConversation returns the active run's conversation for the given request
// ID. Returns nil when no matching run is active or the conversation has not
// been initialized yet. The caller receives the live pointer — mutations are
// visible to the runloop, so callers must treat the returned value as
// read-only or copy what they need.
func (b *ApiBackend) GetConversation(requestID string) *conversation.Conversation {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run.conv == nil {
		return nil
	}
	return run.conv
}

// SearchHistory searches the active run's conversation history for the given
// query, returning up to maxResults matches. Returns nil when no matching run
// is active or the conversation has not been initialized yet.
func (b *ApiBackend) SearchHistory(requestID string, query string, maxResults int) []conversation.HistoryMatch {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run.conv == nil {
		return nil
	}
	return conversation.SearchMessages(run.conv, query, maxResults)
}

// Steer sends a steering message to an active run's conversation. It returns
// true when the message was buffered for delivery, false otherwise. It is a
// thin boolean wrapper over SteerWithReason, retained for callers that do not
// need to distinguish the failure mode.
func (b *ApiBackend) Steer(requestID, message string) bool {
	return b.SteerWithReason(requestID, message) == SteerResultDelivered
}

// SteerWithReason sends a steering message to an active run's conversation and
// reports a typed verdict. The message is buffered on the run's steer channel
// and injected at the next drainSteer checkpoint in the run loop — including
// the post-tool-results checkpoint, which is the one that fires after a parent
// run's dispatched sub-agents (executed as tool calls) complete. That is why a
// steer aimed at a parent parked on its children is delivered rather than
// dropped: it sits in the buffer until executeTools returns.
//
// Every branch logs (engine-grounding §7): the no-run rejection, the
// channel-full rejection, and the successful buffer.
func (b *ApiBackend) SteerWithReason(requestID, message string) SteerResult {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		utils.Warn("ApiBackend", fmt.Sprintf(
			"Steer rejected, no active run: runID=%s msgLen=%d", requestID, len(message),
		))
		return SteerResultNoRun
	}
	select {
	case run.steerCh <- message:
		utils.Log("ApiBackend", fmt.Sprintf(
			"Steer buffered on steer channel: runID=%s msgLen=%d", requestID, len(message),
		))
		return SteerResultDelivered
	default:
		utils.Warn("ApiBackend", fmt.Sprintf(
			"Steer rejected, channel full: runID=%s msgLen=%d", requestID, len(message),
		))
		return SteerResultChannelFull
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
	utils.Debug("ApiBackend", fmt.Sprintf("removeRun: runID=%s", requestID))
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	delete(b.activeRuns, requestID)
	b.mu.Unlock()

	// Signal the run-progress watchdog goroutine to exit immediately.
	// stopWatchdogOnce guards against double-close in the (theoretical)
	// case where removeRun is invoked twice for the same run — e.g.
	// runLoop's defer + a future explicit cleanup path. The select-on-
	// nil-channel guard handles the activeRun-built-without-a-channel
	// case used by some test fixtures (cancelWatchdog test, etc.).
	if ok && run != nil && run.progressWatchdogStop != nil {
		run.stopWatchdogOnce.Do(func() {
			close(run.progressWatchdogStop)
		})
	}
}

// emit forwards a normalized event to the registered onNormalized callback
// (set once by the server). The redaction policy comes from the run's own
// SecurityCfg so concurrent runs with different configs don't leak.
//
// emit is also the single choke point through which the run-progress
// watchdog observes forward progress. Every event that reaches a
// consumer is a "we made progress" signal — provider stream chunks,
// tool results, status updates, error events, etc. all flow through
// this function. Bumping run.lastProgressAt here means we don't have
// to instrument every emit call site individually. The watchdog itself
// lives in runloop_watchdog.go.
//
// The one event that must NOT bump the progress clock is ToolStalledEvent —
// see emitWithoutProgress below for why.
func (b *ApiBackend) emit(run *activeRun, event types.NormalizedEvent) {
	if run != nil {
		run.lastProgressAt.Store(time.Now().UnixNano())
	}
	b.dispatchEvent(run, event)
}

// emitWithoutProgress forwards a normalized event exactly like emit, but does
// NOT bump run.lastProgressAt. It exists for events that are the engine
// signalling the *absence* of progress — specifically ToolStalledEvent, which
// the per-tool stall ticker (runloop_tools.go) emits every ToolStall() while a
// tool runs longer than the stall threshold.
//
// Why this matters: the run-progress watchdog (runloop_watchdog.go) cancels a
// run when no emit lands within RunStall(). If the stall advisory bumped the
// progress clock, a wedged but deadline-exempt Agent/dispatch tool — which the
// runloop intentionally exempts from the per-tool deadline (runloop_tools.go,
// AgentToolName branch) — would emit a ToolStalledEvent every 30s, reset the
// clock every 30s, and never trip the 10-minute run-stall backstop. The event
// meant to *signal* the stall would be the very thing preventing the backstop
// from firing. That is exactly the incident in conversation
// 1782012033034-37d617d3d9ab: a foreground dispatch whose child never reached
// OnExit hung for ~10 minutes emitting ToolStalledEvent every 30s and only
// cleared on engine restart.
//
// Routing the stall advisory through this progress-neutral path lets the
// run-stall watchdog see the genuine idleness and cancel the wedged run.
// Real forward progress (provider chunks, tool results, child activity bumped
// via BumpRunProgress) still flows through emit and still resets the clock.
func (b *ApiBackend) emitWithoutProgress(run *activeRun, event types.NormalizedEvent) {
	b.dispatchEvent(run, event)
}

// dispatchEvent is the shared body of emit and emitWithoutProgress: it applies
// the run's secret-redaction policy and forwards the event to the registered
// onNormalized callback. The only difference between the two public entry
// points is whether they stamp run.lastProgressAt first; keeping the redact +
// forward logic here guarantees the two paths cannot drift.
func (b *ApiBackend) dispatchEvent(run *activeRun, event types.NormalizedEvent) {
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

// BumpRunProgress stamps the run-progress watchdog clock for the named active
// run, if it exists. It is the seam through which a dispatch/spawn layer reports
// that a *child* agent is demonstrably alive (producing events) so the parent
// run — which is parked in the deadline-exempt Agent tool call and therefore
// emits no progress of its own — is not falsely flagged as stalled.
//
// This is the second half of the matched pair documented on emitWithoutProgress:
// the parent's self-emitted stall advisory stops counting as progress, and the
// child's genuine activity starts counting. A dispatch is then "alive" iff its
// child is actually producing events. Nil/absent-run safe.
func (b *ApiBackend) BumpRunProgress(requestID string) {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run == nil {
		return
	}
	run.lastProgressAt.Store(time.Now().UnixNano())
}

// BeginHumanWait marks the named active run as entering an intentional,
// indefinite human-wait (an elicitation — Manager.elicit / ctx.elicit() —
// blocking on a user decision). While a run has one or more open human-waits, the
// run-progress watchdog (runloop_watchdog.go) skips its idle-cancellation check
// for that run: zero forward-progress emits during a human-wait is the expected
// state, not a stall, and the human-wait is indefinite by default (see
// TimeoutsConfig.HumanWait).
//
// Reference-counted via run.humanWaitDepth so overlapping/nested waits resume
// the watchdog only when the last one ends (see EndHumanWait). Nil/absent-run
// safe — a wait on a run that is no longer active is a harmless no-op.
//
// This is the watchdog-side analogue of the per-tool DeadlineSuspender
// (runloop_tools.go), which already exempts the same human-wait span from the
// finite per-tool deadline. The two mechanisms are independent; both must honor
// the indefinite-human-wait guarantee.
func (b *ApiBackend) BeginHumanWait(requestID string) {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run == nil {
		utils.Debug("ApiBackend", fmt.Sprintf(
			"BeginHumanWait: no active run for requestID=%s (no-op)", requestID))
		return
	}
	depth := run.humanWaitDepth.Add(1)
	utils.Log("ApiBackend", fmt.Sprintf(
		"BeginHumanWait: runID=%s humanWaitDepth=%d (watchdog idle-check paused)",
		requestID, depth))
}

// EndHumanWait marks the named active run as leaving a human-wait span opened by
// BeginHumanWait. On the decrement that returns the depth to zero, it stamps
// lastProgressAt = now so the machine work that resumes after the human-wait
// gets a full fresh RunStall() window rather than being retroactively charged
// for the time the human took to respond.
//
// Reference-counted: only the final EndHumanWait (depth 1 → 0) resumes the
// watchdog. Defensive against an unmatched call — depth is floored at 0 and the
// stamp/log still fire so a stray End cannot drive the counter negative and
// permanently disarm the watchdog. Nil/absent-run safe.
func (b *ApiBackend) EndHumanWait(requestID string) {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run == nil {
		utils.Debug("ApiBackend", fmt.Sprintf(
			"EndHumanWait: no active run for requestID=%s (no-op)", requestID))
		return
	}
	depth := run.humanWaitDepth.Add(-1)
	if depth < 0 {
		// Unmatched End (should not happen). Floor at 0 so the watchdog is not
		// left permanently disarmed by a negative depth, and log loudly.
		run.humanWaitDepth.Store(0)
		utils.Error("ApiBackend", fmt.Sprintf(
			"EndHumanWait: unmatched call for runID=%s, depth floored to 0", requestID))
		depth = 0
	}
	if depth == 0 {
		// Resume the watchdog with a fresh window: do not charge the human's
		// think-time against the post-wait machine work.
		run.lastProgressAt.Store(time.Now().UnixNano())
		utils.Log("ApiBackend", fmt.Sprintf(
			"EndHumanWait: runID=%s humanWaitDepth=0 (watchdog idle-check resumed, clock reset)",
			requestID))
	} else {
		utils.Log("ApiBackend", fmt.Sprintf(
			"EndHumanWait: runID=%s humanWaitDepth=%d (still in a human-wait)",
			requestID, depth))
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
