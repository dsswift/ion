package backend

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
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

	// lastNonEmptyResultText holds the most recent non-empty assistant text
	// produced across all turns. Populated each time the end_turn/stop branch
	// builds a non-empty resultText; surfaced as TaskCompleteEvent.LastText so
	// consumers can distinguish a thinking-only final turn (Result empty,
	// LastText carries the last substantive text) from a run that produced no
	// text at all (both empty).
	lastNonEmptyResultText string

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

	// maxTokenThinkingOnlyCount tracks consecutive max_tokens turns where the
	// assistant produced only thinking blocks (no text, no tool calls). When this
	// hits the configured MaxTokenThinkingOnlyBreaker cap, the engine terminates
	// the run rather than injecting another "Continue from where you left off."
	// Reset to 0 whenever a turn produces any non-thinking text or a tool call.
	//
	// This is the circuit breaker for the thinking-budget-exceeds-MaxTokens
	// pathology: when the thinking budget is >= MaxTokens, every turn produces
	// only thinking output, the stop reason is always max_tokens, and the engine
	// would otherwise inject a continuation forever — burning input/output tokens
	// with zero forward progress. See runloop.go's max_tokens case.
	maxTokenThinkingOnlyCount int

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
	cumulativeInputTokens       int
	cumulativeCacheReadTokens   int
	cumulativeCacheCreateTokens int

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

	// currentAttempt is the provider retry-attempt index for the stream the run
	// is currently consuming. Zero on the first (un-retried) attempt; bumped to
	// the real attempt number by the OnRetryWait closure (buildRetryConfig)
	// immediately before each retried stream begins, so processStream reads the
	// attempt that produced the stream it is draining. This backs the
	// provider.ttft telemetry event's "attempt" field (family 4d): a retried
	// stream must report attempt>0, not the hardcoded 0 it previously carried.
	//
	// Atomic because OnRetryWait fires on the WithRetry goroutine while
	// processStream reads on the run goroutine.
	currentAttempt atomic.Int64

	cfg *RunConfig // captured per-run config; nil means "no hooks, no per-run state"
}
