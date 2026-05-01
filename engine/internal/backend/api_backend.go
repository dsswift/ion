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
