package backend

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// acpSpec captures the per-CLI differences between ACP-delegated backends
// (grok, cursor). The mechanism is identical; only the binary, spawn args,
// environment, auth method, and default model differ.
type acpSpec struct {
	kind         string   // backend kind ("grok", "cursor")
	providerID   string   // resolved provider id ("xai", "cursor")
	binary       string   // CLI binary name ("grok", "agent")
	args         []string // spawn args ("agent stdio" / "acp")
	envExtra     []string // extra environment appended to os.Environ()
	authMethodID func() string
	defaultModel string
}

// AcpBackend implements RunBackend by delegating to a persistent ACP agent
// subprocess (grok or cursor). One process hosts one ACP session per engine
// conversation; each engine run is one blocking session/prompt whose streamed
// session/update notifications become NormalizedEvents.
type AcpBackend struct {
	spec acpSpec

	mu          sync.Mutex
	client      *acp.Client
	kill        func()
	started     bool
	loadCapable bool // agent advertises session/load

	runs         map[string]*acpRun // requestID → run
	sessionToRun map[string]string  // ACP sessionId → requestID

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)

	askCb  PermissionAskCallback
	launch acpLauncher
}

// acpRun tracks one active run mapped onto an ACP session.
type acpRun struct {
	requestID    string
	sessionID    string
	model        string
	cancel       context.CancelFunc
	thinkingOpen bool
	lastText     string
	nextTool     int
}

// acpLauncher connects to an ACP agent wired with the given handlers.
type acpLauncher func(spec acpSpec, h acp.Handlers) (client *acp.Client, kill func(), err error)

// NewGrokBackend constructs an ACP backend for the grok CLI.
func NewGrokBackend() *AcpBackend {
	return newAcpBackend(acpSpec{
		kind:         "grok",
		providerID:   "xai",
		binary:       "grok",
		args:         []string{"agent", "stdio"},
		envExtra:     []string{"GROK_OAUTH2_REFERRER=ion"},
		authMethodID: grokAuthMethodID,
		defaultModel: "grok-code",
	})
}

// NewCursorBackend constructs an ACP backend for the cursor `agent` CLI.
func NewCursorBackend() *AcpBackend {
	return newAcpBackend(acpSpec{
		kind:         "cursor",
		providerID:   "cursor",
		binary:       "agent",
		args:         []string{"acp"},
		authMethodID: func() string { return "cursor_login" },
	})
}

// grokAuthMethodID selects the grok auth method: the API-key method when
// XAI_API_KEY is set, otherwise the cached OAuth token.
func grokAuthMethodID() string {
	if os.Getenv("XAI_API_KEY") != "" {
		return "xai.api_key"
	}
	return "cached_token"
}

func newAcpBackend(spec acpSpec) *AcpBackend {
	return &AcpBackend{
		spec:         spec,
		runs:         make(map[string]*acpRun),
		sessionToRun: make(map[string]string),
		launch:       defaultAcpLauncher,
	}
}

// defaultAcpLauncher spawns the real ACP agent subprocess.
func defaultAcpLauncher(spec acpSpec, h acp.Handlers) (*acp.Client, func(), error) {
	binPath, err := cliprobe.Find(spec.binary, nil)
	if err != nil {
		return nil, nil, err
	}
	env := append(os.Environ(), spec.envExtra...)
	proc, err := rpcstdio.Spawn(context.Background(), binPath, spec.args, env, acp.SpawnOptions(spec.kind, h))
	if err != nil {
		return nil, nil, err
	}
	client := acp.NewClientFromRPC(proc.Client, spec.kind, h)
	return client, proc.Kill, nil
}

// SetPermissionAskCallback installs the session's permission-ask bridge.
func (b *AcpBackend) SetPermissionAskCallback(cb PermissionAskCallback) {
	b.mu.Lock()
	b.askCb = cb
	b.mu.Unlock()
}

func (b *AcpBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	b.onNormalized = fn
	b.mu.Unlock()
}

func (b *AcpBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	b.onExit = fn
	b.mu.Unlock()
}

func (b *AcpBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	b.onError = fn
	b.mu.Unlock()
}

func (b *AcpBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.runs[requestID]
	return ok
}

// FlushConversations is a no-op: the ACP agent persists its own sessions.
func (b *AcpBackend) FlushConversations() {}

// WriteToStdin is a no-op: ACP has no mid-prompt steering channel.
func (b *AcpBackend) WriteToStdin(requestID string, msg interface{}) error {
	utils.LogWithFields(utils.LevelDebug, "backend.acp", "WriteToStdin ignored (ACP has no steer)", map[string]any{"kind": b.spec.kind, "request_id": requestID})
	return nil
}

// StartRun begins a run. Plan mode is unsupported and fails fast.
func (b *AcpBackend) StartRun(requestID string, options types.RunOptions) {
	if options.PlanMode {
		b.emitError(requestID, fmt.Errorf("plan mode is not supported on the %s backend", b.spec.kind))
		b.emitExit(requestID, intPtr(1), nil, "")
		return
	}
	go b.runPrompt(requestID, options)
}

// runPrompt ensures the agent+session, then runs one blocking prompt.
func (b *AcpBackend) runPrompt(requestID string, options types.RunOptions) {
	loadCapable, err := b.ensureStarted()
	if err != nil {
		b.emitError(requestID, fmt.Errorf("%s start failed: %w", b.spec.kind, err))
		b.emitExit(requestID, intPtr(1), nil, "")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	sessionID, err := b.openSession(ctx, options, loadCapable)
	if err != nil {
		cancel()
		b.emitError(requestID, fmt.Errorf("%s session setup: %w", b.spec.kind, err))
		b.emitExit(requestID, intPtr(1), nil, "")
		return
	}

	run := &acpRun{requestID: requestID, sessionID: sessionID, model: options.Model, cancel: cancel}
	b.mu.Lock()
	b.runs[requestID] = run
	b.sessionToRun[sessionID] = requestID
	client := b.client
	b.mu.Unlock()

	if options.Model != "" {
		if err := client.SessionSetModel(ctx, sessionID, options.Model); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.acp", "set_model failed (continuing)", map[string]any{"kind": b.spec.kind, "error": err.Error()})
		}
	}

	b.emit(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: sessionID, Model: options.Model}})

	// session/prompt blocks until the turn ends; updates stream meanwhile.
	res, err := client.SessionPrompt(ctx, sessionID, acp.NewTextPrompt(options.Prompt))
	if err != nil {
		b.emitError(requestID, fmt.Errorf("%s prompt: %w", b.spec.kind, err))
		b.finish(requestID, intPtr(1), sessionID)
		return
	}
	b.emit(requestID, b.closeThinkingEvent(requestID))
	b.emit(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Result:    b.runLastText(requestID),
		LastText:  b.runLastText(requestID),
		CostUsd:   0,
		SessionID: sessionID,
	}})
	utils.LogWithFields(utils.LevelInfo, "backend.acp", "prompt completed", map[string]any{"kind": b.spec.kind, "request_id": requestID, "stop_reason": res.StopReason})
	b.finish(requestID, intPtr(0), sessionID)
}

// openSession loads the resumable ACP session when possible, else opens a new
// one. Returns the session id.
func (b *AcpBackend) openSession(ctx context.Context, options types.RunOptions, loadCapable bool) (string, error) {
	b.mu.Lock()
	client := b.client
	b.mu.Unlock()
	if options.CliResumeSessionID != "" && loadCapable {
		if _, err := client.SessionLoad(ctx, options.CliResumeSessionID, options.ProjectPath); err == nil {
			return options.CliResumeSessionID, nil
		}
		// Fall through to a fresh session if load fails.
	}
	res, err := client.SessionNew(ctx, options.ProjectPath)
	if err != nil {
		return "", err
	}
	return res.SessionID, nil
}

// Cancel cancels the active session's prompt.
func (b *AcpBackend) Cancel(requestID string) bool {
	b.mu.Lock()
	run, ok := b.runs[requestID]
	client := b.client
	b.mu.Unlock()
	if !ok || client == nil {
		return false
	}
	if err := client.SessionCancel(run.sessionID); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.acp", "session cancel failed", map[string]any{"kind": b.spec.kind, "error": err.Error()})
	}
	if run.cancel != nil {
		run.cancel()
	}
	return true
}

// finish tears down a run and emits its exit, reporting the session id for
// resume.
func (b *AcpBackend) finish(requestID string, code *int, sessionID string) {
	b.mu.Lock()
	run, ok := b.runs[requestID]
	delete(b.runs, requestID)
	if run != nil {
		delete(b.sessionToRun, run.sessionID)
		if run.cancel != nil {
			run.cancel()
		}
	}
	b.mu.Unlock()
	// Idempotent: if the run was already torn down (e.g. onProcessClosed fired
	// first on process death), do not emit a second exit.
	if !ok {
		return
	}
	b.emitExit(requestID, code, nil, sessionID)
}

// runLastText returns the accumulated assistant text for a run.
func (b *AcpBackend) runLastText(requestID string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if run := b.runs[requestID]; run != nil {
		return run.lastText
	}
	return ""
}

// closeThinkingEvent emits a ThinkingBlockEnd if the run's block is open.
// Returns a zero NormalizedEvent (with nil Data) when nothing to close; emit
// tolerates a nil-Data event by forwarding it, so callers guard on Data.
func (b *AcpBackend) closeThinkingEvent(requestID string) types.NormalizedEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	run := b.runs[requestID]
	if run == nil || !run.thinkingOpen {
		return types.NormalizedEvent{}
	}
	run.thinkingOpen = false
	return types.NormalizedEvent{Data: &types.ThinkingBlockEndEvent{}}
}

// --- emit helpers ---

func (b *AcpBackend) emit(runID string, event types.NormalizedEvent) {
	if event.Data == nil {
		return
	}
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (b *AcpBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	utils.LogWithFields(utils.LevelInfo, "backend.acp", "emitExit", map[string]any{"kind": b.spec.kind, "run_id": runID, "session_id": sessionID})
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *AcpBackend) emitError(runID string, err error) {
	utils.LogWithFields(utils.LevelError, "backend.acp", "emitError", map[string]any{"kind": b.spec.kind, "run_id": runID, "error": utils.ErrStr(err)})
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

// ensureStarted lazily spawns and initializes the ACP agent. Returns whether
// the agent advertises session/load support.
func (b *AcpBackend) ensureStarted() (bool, error) {
	b.mu.Lock()
	if b.started {
		lc := b.loadCapable
		b.mu.Unlock()
		return lc, nil
	}
	b.mu.Unlock()

	handlers := acp.Handlers{
		OnSessionUpdate: b.onSessionUpdate,
		OnPermission:    b.onPermission,
		OnClosed:        b.onProcessClosed,
	}
	client, kill, err := b.launch(b.spec, handlers)
	if err != nil {
		return false, err
	}
	init, err := client.Initialize(context.Background(), acp.ClientInfo{Name: "ion-engine", Version: "1"})
	if err != nil {
		if kill != nil {
			kill()
		}
		return false, fmt.Errorf("%s initialize: %w", b.spec.kind, err)
	}
	// Authenticate with the spec's method when the agent offers auth methods.
	// Best-effort: an already-authenticated agent accepts the cached method;
	// errors are logged and the run proceeds to session setup, which surfaces
	// a clean auth error if the agent truly is not logged in.
	if len(init.AuthMethods) > 0 {
		if err := client.Authenticate(context.Background(), b.spec.authMethodID()); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.acp", "authenticate returned error (continuing)", map[string]any{"kind": b.spec.kind, "error": err.Error()})
		}
	}

	b.mu.Lock()
	b.client = client
	b.kill = kill
	b.started = true
	b.loadCapable = init.AgentCapabilities.LoadSession
	lc := b.loadCapable
	b.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "backend.acp", "agent started", map[string]any{"kind": b.spec.kind, "load_session": lc})
	return lc, nil
}

// onProcessClosed fails active runs when the agent dies and resets the backend.
func (b *AcpBackend) onProcessClosed(err error) {
	b.mu.Lock()
	stale := b.runs
	b.runs = make(map[string]*acpRun)
	b.sessionToRun = make(map[string]string)
	b.started = false
	b.client = nil
	b.kill = nil
	b.mu.Unlock()
	utils.LogWithFields(utils.LevelWarn, "backend.acp", "agent closed, failing active runs", map[string]any{"kind": b.spec.kind, "active": len(stale), "error": errString(err)})
	for reqID := range stale {
		b.emitError(reqID, fmt.Errorf("%s agent exited", b.spec.kind))
		b.emitExit(reqID, intPtr(1), nil, "")
	}
}
