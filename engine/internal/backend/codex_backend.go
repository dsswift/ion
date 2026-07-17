package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CodexBackend implements RunBackend by delegating to a persistent
// `codex app-server` subprocess over JSON-RPC. One process multiplexes every
// conversation as a codex "thread"; each engine run drives one codex "turn".
// Codex owns authentication (ChatGPT subscription or API key), model discovery,
// and tool execution; the backend translates codex's notification stream into
// engine NormalizedEvents and routes codex's approval requests through the
// engine's permission flow.
type CodexBackend struct {
	mu sync.Mutex

	client  *codexrpc.Client
	kill    func()
	started bool

	runs        map[string]*codexRun // requestID → run
	threadToRun map[string]string    // codex threadId → requestID

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)

	// askCb, when set, turns a codex approval request into an engine
	// permission_request and blocks on the user's decision. Nil auto-declines.
	askCb PermissionAskCallback

	// launch connects to a codex app-server and returns a client plus a kill
	// func. Defaults to spawning the real `codex app-server` subprocess; tests
	// override it with a scripted in-process peer.
	launch codexLauncher
}

// codexLauncher connects to a codex app-server wired with the given handlers.
type codexLauncher func(h codexrpc.Handlers) (client *codexrpc.Client, kill func(), err error)

// codexRun tracks one active engine run mapped onto a codex thread+turn.
type codexRun struct {
	requestID string
	threadID  string
	turnID    string
	model     string
	cancel    context.CancelFunc

	// translation state
	thinkingOpen  bool
	lastText      string
	nextToolIndex int

	// plan-mode state. The translate function stashes the completed plan
	// item's markdown in pendingPlanMarkdown under the backend mutex; the
	// notification handler consumes it AFTER unlocking (capturePlanMarkdown
	// does file IO + emits) and latches planCaptured.
	planMode            bool
	planFilePath        string
	planAutoExit        bool
	planCaptured        bool
	pendingPlanMarkdown string
}

// NewCodexBackend constructs an idle CodexBackend. The codex process is spawned
// lazily on the first StartRun.
func NewCodexBackend() *CodexBackend {
	return &CodexBackend{
		runs:        make(map[string]*codexRun),
		threadToRun: make(map[string]string),
		launch:      defaultCodexLauncher,
	}
}

// defaultCodexLauncher spawns the real `codex app-server` subprocess.
func defaultCodexLauncher(h codexrpc.Handlers) (*codexrpc.Client, func(), error) {
	binPath, err := cliprobe.Find(codexBinaryName, nil)
	if err != nil {
		return nil, nil, err
	}
	proc, err := rpcstdio.Spawn(context.Background(), binPath, []string{"app-server"}, nil, codexrpc.SpawnHandlers(h))
	if err != nil {
		return nil, nil, err
	}
	client := codexrpc.NewClientFromRPC(proc.Client, h)
	return client, proc.Kill, nil
}

// SetPermissionAskCallback installs the session's permission-ask bridge so
// codex tool approvals surface as engine_permission_request events. Additive;
// mirrors the claude-code backend's hook-server SetOnAsk.
func (b *CodexBackend) SetPermissionAskCallback(cb PermissionAskCallback) {
	b.mu.Lock()
	b.askCb = cb
	b.mu.Unlock()
}

// OnNormalized registers the normalized-event callback.
func (b *CodexBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	b.onNormalized = fn
	b.mu.Unlock()
}

// OnExit registers the run-exit callback.
func (b *CodexBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	b.onExit = fn
	b.mu.Unlock()
}

// OnError registers the run-error callback.
func (b *CodexBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	b.onError = fn
	b.mu.Unlock()
}

// IsRunning reports whether a run is active.
func (b *CodexBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.runs[requestID]
	return ok
}

// FlushConversations is a no-op: codex persists its own threads.
func (b *CodexBackend) FlushConversations() {}

// StartRun begins a run. Plan mode maps onto codex's native collaboration
// mode (see runTurn); no engine-side gating is layered on top.
func (b *CodexBackend) StartRun(requestID string, options types.RunOptions) {
	go b.runTurn(requestID, options)
}

// runTurn ensures the process is up, opens/reuses the thread, and starts a turn.
func (b *CodexBackend) runTurn(requestID string, options types.RunOptions) {
	if err := b.ensureStarted(); err != nil {
		b.emitError(requestID, fmt.Errorf("codex start failed: %w", err))
		b.emitExit(requestID, intPtr(1), nil, "")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())

	// Resume an existing codex thread when the session carries one, else start
	// fresh. CliResumeSessionID is the codex threadId (see run_options.go). A
	// resume can fail when the thread's rollout no longer exists on disk (codex
	// returns "no rollout found for thread id ..."); fall back to a fresh
	// thread rather than failing the run, mirroring the claude-code / ACP
	// backends' resume-then-fresh behavior.
	var threadID string
	var err error
	if options.CliResumeSessionID != "" {
		threadID, err = b.client.ThreadResume(ctx, codexrpc.ThreadResumeParams{
			ThreadID: options.CliResumeSessionID,
			Cwd:      options.ProjectPath,
			Model:    options.Model,
		})
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.codex", "thread resume failed, starting fresh", map[string]any{
				"request_id": requestID, "thread_id": options.CliResumeSessionID, "error": err.Error(),
			})
			err = nil
			options.CliResumeSessionID = ""
		}
	}
	if threadID == "" {
		threadID, err = b.client.ThreadStart(ctx, codexrpc.ThreadStartParams{
			Cwd:            options.ProjectPath,
			Model:          options.Model,
			ApprovalPolicy: "on-request",
			Sandbox:        "workspace-write",
		})
	}
	if err != nil {
		cancel()
		b.emitError(requestID, fmt.Errorf("codex thread setup: %w", err))
		b.emitExit(requestID, intPtr(1), nil, "")
		return
	}

	run := &codexRun{
		requestID:    requestID,
		threadID:     threadID,
		model:        options.Model,
		cancel:       cancel,
		planMode:     options.PlanMode,
		planFilePath: options.PlanFilePath,
		planAutoExit: resolveCliPlanModeAutoExit(&options),
	}
	b.mu.Lock()
	b.runs[requestID] = run
	b.threadToRun[threadID] = requestID
	b.mu.Unlock()

	// Announce the session so consumers can key their view to the codex thread.
	b.emit(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: threadID, Model: options.Model}})

	// Plan mode rides codex's native collaboration mode, sent only for plan
	// turns. Non-plan turns omit collaborationMode entirely — byte-identical
	// wire to before plan-mode support. (The plan→implement flow starts a
	// fresh session, so there is no sticky plan mode to clear on a non-plan
	// turn; sending a "default" mode here would needlessly require the
	// experimental API on every ordinary turn.)
	var collab *codexrpc.CollaborationMode
	if options.PlanMode {
		collab = &codexrpc.CollaborationMode{
			Mode: "plan",
			Settings: codexrpc.CollaborationModeSettings{
				Model:                 options.Model,
				DeveloperInstructions: resolveCodexPlanInstructions(&options),
			},
		}
		b.emit(requestID, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
			Enabled:      true,
			PlanFilePath: options.PlanFilePath,
			PlanSlug:     types.PlanSlugFromPath(options.PlanFilePath),
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan mode enabled for codex run", map[string]any{
			"run_id":    requestID,
			"plan_file": options.PlanFilePath,
		})
	}

	turnID, err := b.client.TurnStart(ctx, codexrpc.TurnStartParams{
		ThreadID:          threadID,
		Input:             codexrpc.NewTextInput(options.Prompt),
		Model:             options.Model,
		ApprovalPolicy:    "on-request",
		SandboxPolicy:     &codexrpc.SandboxPolicy{Type: "workspaceWrite"},
		CollaborationMode: collab,
	})
	if err != nil {
		b.emitError(requestID, fmt.Errorf("codex turn start: %w", err))
		b.finish(requestID, intPtr(1), threadID)
		return
	}
	b.mu.Lock()
	run.turnID = turnID
	b.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "backend.codex", "turn started", map[string]any{"request_id": requestID, "thread_id": threadID, "turn_id": turnID})
}

// Cancel interrupts the active turn.
func (b *CodexBackend) Cancel(requestID string) bool {
	b.mu.Lock()
	run, ok := b.runs[requestID]
	client := b.client
	b.mu.Unlock()
	if !ok || client == nil {
		return false
	}
	if err := client.TurnInterrupt(context.Background(), run.threadID, run.turnID); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.codex", "turn interrupt failed", map[string]any{"request_id": requestID, "error": err.Error()})
	}
	if run.cancel != nil {
		run.cancel()
	}
	return true
}

// WriteToStdin routes a follow-up message into the active turn via turn/steer.
func (b *CodexBackend) WriteToStdin(requestID string, msg interface{}) error {
	text, ok := steerText(msg)
	if !ok {
		return nil
	}
	b.mu.Lock()
	run, present := b.runs[requestID]
	client := b.client
	b.mu.Unlock()
	if !present || client == nil {
		return nil
	}
	newTurn, err := client.TurnSteer(context.Background(), run.threadID, run.turnID, codexrpc.NewTextInput(text))
	if err != nil {
		return err
	}
	b.mu.Lock()
	run.turnID = newTurn
	b.mu.Unlock()
	return nil
}

// steerText extracts a text payload from a WriteToStdin message. It accepts a
// bare string or a map carrying a "text" field.
func steerText(msg interface{}) (string, bool) {
	switch v := msg.(type) {
	case string:
		return v, v != ""
	case map[string]any:
		if s, ok := v["text"].(string); ok && s != "" {
			return s, true
		}
	}
	return "", false
}

// finish tears down a run and emits its exit. threadID is reported as the
// backend session id so the session layer can resume the thread next run.
func (b *CodexBackend) finish(requestID string, code *int, threadID string) {
	b.mu.Lock()
	run, ok := b.runs[requestID]
	delete(b.runs, requestID)
	if run != nil {
		delete(b.threadToRun, run.threadID)
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
	b.emitExit(requestID, code, nil, threadID)
}

// --- notification + approval handlers (wired via codexrpc.SpawnHandlers) ---

// onNotification routes a codex server notification to its run and translates
// it into NormalizedEvents.
func (b *CodexBackend) onNotification(method string, params json.RawMessage) {
	threadID := probeThreadID(params)
	b.mu.Lock()
	requestID := b.threadToRun[threadID]
	run := b.runs[requestID]
	// Translate under the lock (mutates run state) but emit after releasing it.
	events, exit := translateCodexNotification(run, method, params)
	// A completed plan item stashed its markdown; consume it under the lock
	// and latch planCaptured so a later turn/completed skips the auto-exit
	// synthesis. The capture itself (file IO + emits) runs after unlock.
	var pendingPlan, planPath string
	if run != nil && run.pendingPlanMarkdown != "" {
		pendingPlan = run.pendingPlanMarkdown
		planPath = run.planFilePath
		run.pendingPlanMarkdown = ""
		run.planCaptured = true
	}
	b.mu.Unlock()

	if run == nil && method != codexrpc.NotifError {
		return
	}
	if pendingPlan != "" {
		if _, err := capturePlanMarkdown(requestID, pendingPlan, planPath, true, 0, b.emit); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.codex", "native plan capture failed", map[string]any{
				"run_id": requestID, "error": err.Error(),
			})
		}
	}
	for _, ev := range events {
		b.emit(requestID, ev)
	}
	if exit != nil {
		b.finish(requestID, exit.code, threadID)
	}
}

// onCommandApproval bridges a codex command-execution approval into the engine
// permission flow, blocking on the user's decision.
func (b *CodexBackend) onCommandApproval(p codexrpc.CommandApprovalParams) string {
	return b.resolveApproval(p.ThreadID, "Bash", p.Command, map[string]any{"command": p.Command, "cwd": p.Cwd})
}

// onFileChangeApproval bridges a codex file-change approval into the engine
// permission flow.
func (b *CodexBackend) onFileChangeApproval(p codexrpc.FileChangeApprovalParams) string {
	return b.resolveApproval(p.ThreadID, "Edit", "apply file changes", map[string]any{"itemId": p.ItemID})
}

// resolveApproval emits an engine_permission_request (via the session ask
// callback) and maps the chosen option to a codex decision. Auto-declines when
// no callback is installed or the run is unknown.
func (b *CodexBackend) resolveApproval(threadID, toolName, desc string, input map[string]any) string {
	b.mu.Lock()
	requestID := b.threadToRun[threadID]
	askCb := b.askCb
	b.mu.Unlock()
	if askCb == nil || requestID == "" {
		utils.LogWithFields(utils.LevelInfo, "backend.codex", "approval auto-declined (no ask callback or run)", map[string]any{"thread_id": threadID})
		return codexrpc.DecisionDecline
	}
	options := []types.PermissionOpt{
		{ID: "allow", Label: "Allow", Kind: "allow"},
		{ID: "deny", Label: "Deny", Kind: "deny"},
	}
	ch := askCb(requestID, "codex-"+threadID, toolName, desc, input, options)
	if ch == nil {
		return codexrpc.DecisionDecline
	}
	optionID := <-ch
	if optionID == "allow" {
		return codexrpc.DecisionAccept
	}
	return codexrpc.DecisionDecline
}

// probeThreadID extracts the threadId from any notification payload for routing.
func probeThreadID(params json.RawMessage) string {
	var probe struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(params, &probe)
	return probe.ThreadID
}

// --- emit helpers (same shape as the claude-code backend) ---

func (b *CodexBackend) emit(runID string, event types.NormalizedEvent) {
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (b *CodexBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	utils.LogWithFields(utils.LevelInfo, "backend.codex", "emitExit", map[string]any{"run_id": runID, "session_id": sessionID})
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *CodexBackend) emitError(runID string, err error) {
	utils.LogWithFields(utils.LevelError, "backend.codex", "emitError", map[string]any{"run_id": runID, "error": utils.ErrStr(err)})
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

// codexBinaryName is the codex CLI binary the backend spawns.
const codexBinaryName = "codex"

// codexClientTag identifies this client to the codex app-server in the
// initialize handshake. It is codex's client-identification field (akin to a
// User-Agent), not the Ion engine release version.
const codexClientTag = "ion-engine"

// ensureStarted lazily spawns and initializes the codex app-server process. It
// is safe to call concurrently; only the first caller spawns.
func (b *CodexBackend) ensureStarted() error {
	b.mu.Lock()
	if b.started {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()

	handlers := codexrpc.Handlers{
		OnNotification:       b.onNotification,
		OnCommandApproval:    b.onCommandApproval,
		OnFileChangeApproval: b.onFileChangeApproval,
		OnClosed:             b.onProcessClosed,
	}
	client, kill, err := b.launch(handlers)
	if err != nil {
		return err
	}
	if _, err := client.Initialize(context.Background(), codexrpc.ClientInfo{Name: codexClientTag, Version: "1"}); err != nil {
		if kill != nil {
			kill()
		}
		return fmt.Errorf("codex initialize: %w", err)
	}

	b.mu.Lock()
	b.client = client
	b.kill = kill
	b.started = true
	b.mu.Unlock()
	utils.Log("backend.codex", "codex app-server started")
	return nil
}

// onProcessClosed fails every active run when the codex process dies and resets
// the backend so the next StartRun respawns.
func (b *CodexBackend) onProcessClosed(err error) {
	b.mu.Lock()
	stale := b.runs
	b.runs = make(map[string]*codexRun)
	b.threadToRun = make(map[string]string)
	b.started = false
	b.client = nil
	b.kill = nil
	b.mu.Unlock()
	utils.LogWithFields(utils.LevelWarn, "backend.codex", "codex process closed, failing active runs", map[string]any{"active": len(stale), "error": errString(err)})
	for reqID := range stale {
		b.emitError(reqID, fmt.Errorf("codex process exited"))
		b.emitExit(reqID, intPtr(1), nil, "")
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
