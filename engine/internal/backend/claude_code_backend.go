package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/normalizer"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/stream"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// claudeCodeRun tracks an active Claude CLI process.
type claudeCodeRun struct {
	requestID    string
	cmd          *exec.Cmd
	cancel       context.CancelFunc
	stderr       *rpcstdio.RingBuffer
	stdinPipe    io.WriteCloser
	stdinMu      sync.Mutex
	planMode     bool
	planFilePath string
	// planCaptured latches once the native plan has been written to the plan
	// file (from the ExitPlanMode argument or a plans-file Write fallback —
	// see handlePlanModeAssistant/handlePlanModeResult), so the result handler
	// does not double-surface the proposal.
	planCaptured bool
	// sawExitPlanMode latches when the ExitPlanMode tool_use appears in the
	// assistant stream, regardless of whether it carried plan text. This is
	// the RELIABLE "the model proposed exiting plan mode" signal: newer
	// claude-code (2.1.x) auto-approves ExitPlanMode under the engine's
	// bypass permission mode, so it does NOT appear in the result event's
	// permission_denials — the result-denial-based detection misses it and the
	// run falls through to the (wrong) auto-exit-with-empty-plan path.
	sawExitPlanMode bool
	// pendingPlanFromFile holds the content of the most recent Write to a
	// plans file (~/.claude/plans/<slug>.md or the run's own plan file) seen
	// in the assistant stream. Newer claude-code writes the plan to its own
	// plans directory via the Write tool and then calls ExitPlanMode with an
	// EMPTY argument, so this is the fallback plan source when ExitPlanMode
	// carries no text.
	pendingPlanFromFile string
}

// ClaudeCodeBackend implements RunBackend by spawning the Claude Code CLI
// (`claude -p --output-format stream-json`) and parsing its NDJSON output
// through the normalizer pipeline.
type ClaudeCodeBackend struct {
	mu         sync.Mutex
	activeRuns map[string]*claudeCodeRun

	// lastCumulativeCost tracks the Claude CLI's cumulative total_cost_usd
	// per conversation so TaskCompleteEvent.CostUsd can be delta-normalized
	// to a per-run cost. Claude CLI reports a session-cumulative value; the
	// engine contract (and all consumers including the dashboard) expect a
	// per-run value matching ApiBackend's semantics.
	// Key: conversationID (from the CLI's session ID or our own ID).
	lastCumulativeCost map[string]float64

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)
}

// NewClaudeCodeBackend creates a ClaudeCodeBackend ready for use.
func NewClaudeCodeBackend() *ClaudeCodeBackend {
	return &ClaudeCodeBackend{
		activeRuns:         make(map[string]*claudeCodeRun),
		lastCumulativeCost: make(map[string]float64),
	}
}

// OnNormalized registers the callback for normalized events.
func (b *ClaudeCodeBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onNormalized = fn
}

// OnExit registers the callback for run exit events.
func (b *ClaudeCodeBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onExit = fn
}

// OnError registers the callback for run errors.
func (b *ClaudeCodeBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onError = fn
}

// IsRunning reports whether a run is currently active.
func (b *ClaudeCodeBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.activeRuns[requestID]
	return ok
}

// Cancel stops a running CLI process. Sends SIGINT first, then escalates
// to SIGKILL after 5 seconds if the process hasn't exited.
func (b *ClaudeCodeBackend) Cancel(requestID string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()

	if !ok {
		return false
	}

	proc := run.cmd.Process
	if proc == nil {
		run.cancel()
		return true
	}

	// Send SIGINT (graceful) on Unix, Kill directly on Windows
	if runtime.GOOS == "windows" {
		_ = proc.Kill()
		run.cancel()
		return true
	}

	if err := proc.Signal(syscall.SIGINT); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "SIGINT failed, killing", map[string]any{
			"error": utils.ErrStr(err),
		})
		_ = proc.Kill()
		run.cancel()
		return true
	}

	// Escalate to SIGKILL after 5 seconds
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()

		<-timer.C
		// Check if still running
		b.mu.Lock()
		_, stillActive := b.activeRuns[requestID]
		b.mu.Unlock()
		if stillActive {
			utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "process did not exit after SIGINT, sending SIGKILL", map[string]any{
				"request_id": requestID,
			})
			_ = proc.Signal(syscall.SIGKILL)
			run.cancel()
		}
	}()

	return true
}

// StartRun spawns a Claude CLI process and streams its output through
// the normalizer pipeline.
func (b *ClaudeCodeBackend) StartRun(requestID string, options types.RunOptions) {
	// Derive the run's cancellation context from the session root when the
	// caller threaded one (RunOptions.ParentCtx), so a session-level abort
	// cascades to this CLI process's context (which the run loop honors via
	// ctx.Done() and Cancel() escalates to SIGINT/SIGKILL). Falls back to
	// context.Background() for callers that don't supply a parent.
	parent := options.ParentCtx
	if parent == nil {
		parent = context.Background()
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "StartRun: no ParentCtx; using Background", map[string]any{
			"request_id": requestID,
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "StartRun: deriving run ctx from session ParentCtx", map[string]any{
			"request_id": requestID,
		})
	}
	ctx, cancel := context.WithCancel(parent)

	run := &claudeCodeRun{
		requestID: requestID,
		cancel:    cancel,
		stderr:    rpcstdio.NewRingBuffer(100),
	}

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	go b.runProcess(ctx, run, options)
}

// findClaudeBinary locates the claude CLI binary via the shared cliprobe.Find
// discovery (fixed install paths, $PATH, then a login-shell fallback).
func findClaudeBinary() (string, error) {
	return cliprobe.Find("claude", nil)
}

// runProcess is the goroutine that manages the Claude CLI process lifecycle.
func (b *ClaudeCodeBackend) runProcess(ctx context.Context, run *claudeCodeRun, opts types.RunOptions) {
	// Capture plan state so the event loop can enrich ExitPlanMode denials.
	run.planMode = opts.PlanMode
	run.planFilePath = opts.PlanFilePath

	// Delay cleanup by 5s so callers can read diagnostics (stderr) after exit
	defer func() {
		time.AfterFunc(5*time.Second, func() {
			b.removeRun(run.requestID)
		})
	}()

	claudePath, err := findClaudeBinary()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.claude_code", "claude binary not found", map[string]any{
			"error": utils.ErrStr(err),
		})
		b.emitError(run.requestID, err)
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	// Build command arguments -- use stream-json for bidirectional stdin
	args := []string{
		"-p",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}

	// Permission mode: respect caller override, default to "bypassPermissions".
	// The engine is security-free by design — the harness is responsible for
	// implementing whatever approval layer it needs via hooks.  Defaulting to
	// "auto" would inject Claude Code's interactive prompts, which hangs
	// headless / daemon deployments where no user is present to approve.
	// Plan mode: delegate to the CLI's native --permission-mode plan rather
	// than injecting our own plan prompt on top of bypassPermissions.
	permMode := "bypassPermissions"
	if opts.PlanMode {
		permMode = "plan"
	} else if opts.PermissionModeCli != "" {
		permMode = opts.PermissionModeCli
	}
	args = append(args, "--permission-mode", permMode)

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.MaxTurns > 0 {
		args = append(args, "--max-turns", strconv.Itoa(opts.MaxTurns))
	}
	if opts.MaxBudgetUsd > 0 {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(opts.MaxBudgetUsd, 'f', -1, 64))
	}
	// Resume only with claude's own captured session UUID (CliResumeSessionID),
	// never with Ion's conversation id (opts.ConversationID). See cliResumeArgs.
	args = append(args, cliResumeArgs(opts)...)
	for _, dir := range opts.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}

	// Plan mode adds no supplementary prompt: the CLI's native plan mode owns
	// the behavioral framework (read-only tools, phases, ExitPlanMode), and the
	// engine captures the plan text from the native ExitPlanMode tool argument
	// (see handlePlanModeAssistant), writing it to the Ion plan file itself.
	if opts.AppendSystemPrompt != "" {
		args = append(args, "--append-system-prompt", opts.AppendSystemPrompt)
	}

	// Allowed tools: use provided list, or restrict when hook settings injected.
	// Plan mode deliberately does NOT force Write/Edit in: the plan is captured
	// from the native ExitPlanMode argument, so the model never authors a plan
	// file itself and stray plan-file writes are not a supported path.
	allowedTools := opts.AllowedTools
	if len(allowedTools) == 0 {
		if opts.HookSettingsPath != "" {
			// Restrict to safe read-only + agent tools when running with hook settings
			allowedTools = []string{"Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "TaskCreate", "TaskList", "TaskGet", "LSP", "NotebookEdit"}
		} else {
			allowedTools = []string{"Read", "Glob", "Grep", "LS", "Agent", "WebSearch", "WebFetch"}
		}
	}
	// When an MCP ToolServer is wired, add the wildcard allowlist entry so
	// the CLI offers all tools from the ion-extensions MCP server to the model.
	if opts.McpConfig != "" {
		allowedTools = append(allowedTools, "mcp__"+McpServerName+"__*")
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "added MCP wildcard to allowedTools: mcp____*", map[string]any{
			"mcp_server_name": McpServerName,
		})
	}
	args = append(args, "--allowedTools", strings.Join(allowedTools, ","))

	if opts.McpConfig != "" {
		args = append(args, "--mcp-config", opts.McpConfig)
	}

	if opts.HookSettingsPath != "" {
		args = append(args, "--settings", opts.HookSettingsPath)
	}

	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "spawning", map[string]any{
		"claude_path": claudePath,
		"args":        strings.Join(args, " "),
	})

	// Emit the state-transition event so consumers can mirror the active
	// plan-mode flag for this run. Carries the plan file path + slug so
	// consumers can key the plan surface without waiting for the proposal.
	if run.planMode {
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
			Enabled:      true,
			PlanFilePath: run.planFilePath,
			PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan mode enabled for claude-code run", map[string]any{
			"run_id":    run.requestID,
			"plan_file": run.planFilePath,
		})
	}

	cmd := exec.CommandContext(ctx, claudePath, args...)

	// When MCP tools are wired, disable tool search so all bridged tools
	// appear in the model's upfront tool list. ENABLE_TOOL_SEARCH defaults
	// on in Claude Code, which hides MCP tools behind a lazy search step
	// in headless (-p) mode.
	if opts.McpConfig != "" {
		cmd.Env = append(os.Environ(), "ENABLE_TOOL_SEARCH=false")
		utils.Log("ClaudeCodeBackend", "set ENABLE_TOOL_SEARCH=false for MCP tools")
	}

	// Set working directory if specified
	if opts.ProjectPath != "" {
		cmd.Dir = opts.ProjectPath
	}

	run.cmd = cmd

	// Pipe stdin for bidirectional stream-json communication
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.claude_code", "stdin pipe failed", map[string]any{
			"error": utils.ErrStr(err),
		})
		b.emitError(run.requestID, fmt.Errorf("failed to create stdin pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}
	run.stdinPipe = stdinPipe

	// Pipe stdout for NDJSON parsing
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.claude_code", "stdout pipe failed", map[string]any{
			"error": utils.ErrStr(err),
		})
		b.emitError(run.requestID, fmt.Errorf("failed to create stdout pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	// Pipe stderr for diagnostics capture
	stderr, err := cmd.StderrPipe()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.claude_code", "stderr pipe failed", map[string]any{
			"error": utils.ErrStr(err),
		})
		b.emitError(run.requestID, fmt.Errorf("failed to create stderr pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	if err := cmd.Start(); err != nil {
		utils.LogWithFields(utils.LevelError, "backend.claude_code", "process start failed", map[string]any{
			"error": utils.ErrStr(err),
		})
		b.emitError(run.requestID, fmt.Errorf("failed to start claude CLI: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "process started", map[string]any{
		"pid":        cmd.Process.Pid,
		"request_id": run.requestID,
	})

	// Write initial prompt as NDJSON user message over stdin. PDFs/images
	// referenced by the prompt are inlined as native document/image content
	// blocks rather than left for the Read tool to expand (#789).
	initMsg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role":    "user",
			"content": buildCliUserContent(opts.Prompt, opts.Attachments),
		},
	}
	if data, err := json.Marshal(initMsg); err == nil {
		_, _ = stdinPipe.Write(append(data, '\n'))
	}

	// Capture stderr in ring buffer
	var stderrDone sync.WaitGroup
	stderrDone.Add(1)
	go func() {
		defer stderrDone.Done()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			run.stderr.Write(scanner.Text())
		}
	}()

	// Parse NDJSON from stdout and normalize events
	var sessionID string
	parser := stream.NewParser(stdout)
	for {
		raw, ok := parser.Next()
		if !ok {
			break
		}

		// Close stdin when a result event is received (run complete)
		var peek struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &peek) == nil && peek.Type == "result" {
			run.stdinMu.Lock()
			if run.stdinPipe != nil {
				_ = run.stdinPipe.Close()
				run.stdinPipe = nil
			}
			run.stdinMu.Unlock()
		}

		events := normalizer.Normalize(raw)
		for _, ev := range events {
			// Track sessionID from init or result events
			switch e := ev.Data.(type) {
			case *types.SessionInitEvent:
				if e.SessionID != "" {
					sessionID = e.SessionID
				}
			case *types.TaskUpdateEvent:
				// Plan mode: the CLI streams the fully-populated ExitPlanMode
				// tool_use (its input carries the plan text) in the assistant
				// message BEFORE the result/denial arrives. Capture it here.
				if run.planMode && !run.planCaptured {
					b.handlePlanModeAssistant(run, e)
				}
			case *types.TaskCompleteEvent:
				if e.SessionID != "" {
					sessionID = e.SessionID
				}
				// Delta-normalize the cost. Claude CLI reports a
				// session-cumulative total_cost_usd; the engine wire
				// contract (and ApiBackend) emit a per-run cost. Subtract
				// the last known cumulative to produce a run-incremental
				// value. Key by sessionID (the CLI's own session UUID) so
				// each CLI session tracks independently.
				costKey := sessionID
				if costKey == "" {
					costKey = opts.ConversationID
				}
				b.mu.Lock()
				cumulativeCost := e.CostUsd
				last := b.lastCumulativeCost[costKey]
				runCost := cumulativeCost - last
				if runCost < 0 {
					// Should not happen; treat as full cost (new session).
					runCost = cumulativeCost
				}
				b.lastCumulativeCost[costKey] = cumulativeCost
				b.mu.Unlock()
				e.CostUsd = runCost
				utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "cost delta", map[string]any{
					"run_id":     run.requestID,
					"key":        costKey,
					"cumulative": cumulativeCost,
					"last":       last,
					"delta":      runCost,
				})

				// Plan mode result handling: enrich the ExitPlanMode denial
				// with the plan file path and, when needed, surface the
				// proposal or synthesize the auto-exit safety net — all
				// BEFORE the TaskCompleteEvent is emitted, matching the
				// ApiBackend's contract order. See handlePlanModeResult.
				if run.planMode {
					b.handlePlanModeResult(run, e, &opts)
				}
			}
			b.emit(run.requestID, ev)
		}
	}

	// Wait for stderr goroutine to finish before calling cmd.Wait
	stderrDone.Wait()

	// Wait for process to exit
	waitErr := cmd.Wait()

	exitCode := 0
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			// Non-exit error (e.g., signal)
			exitCode = 1
		}
	}

	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "process exited", map[string]any{
		"pid":        cmd.Process.Pid,
		"code":       exitCode,
		"request_id": run.requestID,
	})

	if exitCode != 0 {
		stderrLines := run.stderr.Lines()
		if len(stderrLines) > 0 {
			errMsg := fmt.Sprintf("claude CLI exited with code %d: %s", exitCode, strings.Join(stderrLines, "\n"))
			b.emitError(run.requestID, fmt.Errorf("%s", errMsg))
		} else {
			b.emitError(run.requestID, fmt.Errorf("claude CLI exited with code %d", exitCode))
		}
	}

	b.emitExit(run.requestID, &exitCode, nil, sessionID)
}

// WriteToStdin sends a JSON message to a running CLI process over its stdin pipe.
// The message is marshalled to JSON and written as a single NDJSON line.
// FlushConversations is a no-op for ClaudeCodeBackend; the underlying CLI process
// owns its own persistence. RunBackend interface compliance.
func (b *ClaudeCodeBackend) FlushConversations() {}

func (b *ClaudeCodeBackend) WriteToStdin(requestID string, msg interface{}) error {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		return fmt.Errorf("run %q not found", requestID)
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal stdin message: %w", err)
	}

	run.stdinMu.Lock()
	defer run.stdinMu.Unlock()
	if run.stdinPipe == nil {
		return fmt.Errorf("stdin pipe closed for run %q", requestID)
	}
	if _, err := run.stdinPipe.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write to stdin: %w", err)
	}
	return nil
}

func (b *ClaudeCodeBackend) removeRun(requestID string) {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	if ok {
		// Ensure stdin pipe is closed on cleanup
		run.stdinMu.Lock()
		if run.stdinPipe != nil {
			_ = run.stdinPipe.Close()
			run.stdinPipe = nil
		}
		run.stdinMu.Unlock()
	}
	delete(b.activeRuns, requestID)
	b.mu.Unlock()
}

func (b *ClaudeCodeBackend) emit(runID string, event types.NormalizedEvent) {
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (b *ClaudeCodeBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "emitExit", map[string]any{
		"run_id":     runID,
		"code":       codeStr,
		"signal":     sigStr,
		"session_id": sessionID,
	})
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *ClaudeCodeBackend) emitError(runID string, err error) {
	utils.LogWithFields(utils.LevelError, "backend.claude_code", "emitError", map[string]any{
		"run_id": runID,
		"error":  utils.ErrStr(err),
	})
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}
