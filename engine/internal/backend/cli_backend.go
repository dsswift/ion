package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/normalizer"
	"github.com/dsswift/ion/engine/internal/stream"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ringBuffer holds the last N lines written to it, used to capture stderr
// output for diagnostics when a CLI process fails.
type ringBuffer struct {
	lines []string
	size  int
	mu    sync.Mutex
}

func newRingBuffer(size int) *ringBuffer {
	return &ringBuffer{
		lines: make([]string, 0, size),
		size:  size,
	}
}

func (rb *ringBuffer) Write(line string) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if len(rb.lines) >= rb.size {
		rb.lines = rb.lines[1:]
	}
	rb.lines = append(rb.lines, line)
}

func (rb *ringBuffer) Lines() []string {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := make([]string, len(rb.lines))
	copy(out, rb.lines)
	return out
}

// cliRun tracks an active Claude CLI process.
type cliRun struct {
	requestID    string
	cmd          *exec.Cmd
	cancel       context.CancelFunc
	stderr       *ringBuffer
	stdinPipe    io.WriteCloser
	stdinMu      sync.Mutex
	planMode     bool
	planFilePath string
}

// CliBackend implements RunBackend by spawning the Claude Code CLI
// (`claude -p --output-format stream-json`) and parsing its NDJSON output
// through the normalizer pipeline.
type CliBackend struct {
	mu         sync.Mutex
	activeRuns map[string]*cliRun

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)
}

// NewCliBackend creates a CliBackend ready for use.
func NewCliBackend() *CliBackend {
	return &CliBackend{
		activeRuns: make(map[string]*cliRun),
	}
}

// OnNormalized registers the callback for normalized events.
func (b *CliBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onNormalized = fn
}

// OnExit registers the callback for run exit events.
func (b *CliBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onExit = fn
}

// OnError registers the callback for run errors.
func (b *CliBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onError = fn
}

// IsRunning reports whether a run is currently active.
func (b *CliBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.activeRuns[requestID]
	return ok
}

// Cancel stops a running CLI process. Sends SIGINT first, then escalates
// to SIGKILL after 5 seconds if the process hasn't exited.
func (b *CliBackend) Cancel(requestID string) bool {
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
		utils.Log("CliBackend", "SIGINT failed, killing: "+err.Error())
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
			utils.Log("CliBackend", "process did not exit after SIGINT, sending SIGKILL: "+requestID)
			_ = proc.Signal(syscall.SIGKILL)
			run.cancel()
		}
	}()

	return true
}

// StartRun spawns a Claude CLI process and streams its output through
// the normalizer pipeline.
func (b *CliBackend) StartRun(requestID string, options types.RunOptions) {
	// Derive the run's cancellation context from the session root when the
	// caller threaded one (RunOptions.ParentCtx), so a session-level abort
	// cascades to this CLI process's context (which the run loop honors via
	// ctx.Done() and Cancel() escalates to SIGINT/SIGKILL). Falls back to
	// context.Background() for callers that don't supply a parent.
	parent := options.ParentCtx
	if parent == nil {
		parent = context.Background()
		utils.Debug("CliBackend", "StartRun: no ParentCtx; using Background requestID="+requestID)
	} else {
		utils.Debug("CliBackend", "StartRun: deriving run ctx from session ParentCtx requestID="+requestID)
	}
	ctx, cancel := context.WithCancel(parent)

	run := &cliRun{
		requestID: requestID,
		cancel:    cancel,
		stderr:    newRingBuffer(100),
	}

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	go b.runProcess(ctx, run, options)
}

// findClaudeBinary locates the claude CLI binary on the system.
// Search order matches TS run-manager.ts:
//  1. /usr/local/bin/claude
//  2. /opt/homebrew/bin/claude
//  3. ~/.npm-global/bin/claude
//  4. exec.LookPath (current $PATH)
//  5. login shell fallback (zsh/bash -l -c "which claude"), covers npm-global
//     installs where $PATH is set only in shell profiles (Unix only)
func findClaudeBinary() (string, error) {
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
		filepath.Join(home, ".npm-global", "bin", "claude"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	// Login shell fallback for environments where PATH is set in shell profiles
	// (e.g. ~/.zshrc, ~/.bash_profile) but not in the Go process environment.
	if runtime.GOOS != "windows" {
		for _, shell := range []string{"zsh", "bash"} {
			if shellPath, err := exec.LookPath(shell); err == nil {
				out, err := exec.Command(shellPath, "-l", "-c", "which claude 2>/dev/null").Output()
				if err == nil {
					if p := strings.TrimSpace(string(out)); p != "" {
						if _, err := os.Stat(p); err == nil {
							return p, nil
						}
					}
				}
			}
		}
	}
	return "", fmt.Errorf("claude CLI not found: checked /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, $PATH, and login shell")
}

// runProcess is the goroutine that manages the Claude CLI process lifecycle.
func (b *CliBackend) runProcess(ctx context.Context, run *cliRun, opts types.RunOptions) {
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
		utils.Error("CliBackend", "claude binary not found: "+err.Error())
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
	// never with Ion's conversation id (opts.SessionID). See cliResumeArgs.
	args = append(args, cliResumeArgs(opts)...)
	for _, dir := range opts.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}

	// Plan mode: append a supplementary directive telling the model to write
	// the plan to our managed file path. The CLI's native plan mode handles
	// the behavioral framework (read-only tools, phases, ExitPlanMode); we
	// just redirect where the plan lands on disk.
	appendSys := opts.AppendSystemPrompt
	if opts.PlanMode && opts.PlanFilePath != "" {
		planDirective := fmt.Sprintf("\n\n[ION PLAN FILE]\nWrite your implementation plan to this file: %s\n"+
			"This is the only file you should create or edit. Use the Write tool to write the plan.\n"+
			"When the plan is complete, call ExitPlanMode.", opts.PlanFilePath)
		appendSys += planDirective
	}
	if appendSys != "" {
		args = append(args, "--append-system-prompt", appendSys)
	}

	// Allowed tools: use provided list, or restrict when hook settings injected.
	// Plan mode: always include Write and Edit so the model can write the plan
	// file (the CLI's native plan mode gates which paths are writable).
	allowedTools := opts.AllowedTools
	if len(allowedTools) == 0 {
		if opts.HookSettingsPath != "" {
			// Restrict to safe read-only + agent tools when running with hook settings
			allowedTools = []string{"Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "TaskCreate", "TaskList", "TaskGet", "LSP", "NotebookEdit"}
		} else {
			allowedTools = []string{"Read", "Glob", "Grep", "LS", "Agent", "WebSearch", "WebFetch"}
		}
	}
	if opts.PlanMode {
		// Ensure Write/Edit are available for the plan file even if not in
		// the base set. The CLI's plan mode restricts what can be written.
		has := make(map[string]bool, len(allowedTools))
		for _, t := range allowedTools {
			has[t] = true
		}
		for _, need := range []string{"Write", "Edit"} {
			if !has[need] {
				allowedTools = append(allowedTools, need)
			}
		}
	}
	// When an MCP ToolServer is wired, add the wildcard allowlist entry so
	// the CLI offers all tools from the ion-extensions MCP server to the model.
	if opts.McpConfig != "" {
		allowedTools = append(allowedTools, "mcp__"+McpServerName+"__*")
		utils.Log("CliBackend", fmt.Sprintf("added MCP wildcard to allowedTools: mcp__%s__*", McpServerName))
	}
	args = append(args, "--allowedTools", strings.Join(allowedTools, ","))

	if opts.McpConfig != "" {
		args = append(args, "--mcp-config", opts.McpConfig)
	}

	if opts.HookSettingsPath != "" {
		args = append(args, "--settings", opts.HookSettingsPath)
	}

	utils.Log("CliBackend", fmt.Sprintf("spawning: %s %s", claudePath, strings.Join(args, " ")))

	// Emit the state-transition event so consumers can mirror the active
	// plan-mode flag for this run.
	if run.planMode {
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true}})
		utils.Info("PlanMode", fmt.Sprintf("cli run=%s plan_file=%s", run.requestID, run.planFilePath))
	}

	cmd := exec.CommandContext(ctx, claudePath, args...)

	// When MCP tools are wired, disable tool search so all bridged tools
	// appear in the model's upfront tool list. ENABLE_TOOL_SEARCH defaults
	// on in Claude Code, which hides MCP tools behind a lazy search step
	// in headless (-p) mode.
	if opts.McpConfig != "" {
		cmd.Env = append(os.Environ(), "ENABLE_TOOL_SEARCH=false")
		utils.Log("CliBackend", "set ENABLE_TOOL_SEARCH=false for MCP tools")
	}

	// Set working directory if specified
	if opts.ProjectPath != "" {
		cmd.Dir = opts.ProjectPath
	}

	run.cmd = cmd

	// Pipe stdin for bidirectional stream-json communication
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		utils.Error("CliBackend", "stdin pipe failed: "+err.Error())
		b.emitError(run.requestID, fmt.Errorf("failed to create stdin pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}
	run.stdinPipe = stdinPipe

	// Pipe stdout for NDJSON parsing
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		utils.Error("CliBackend", "stdout pipe failed: "+err.Error())
		b.emitError(run.requestID, fmt.Errorf("failed to create stdout pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	// Pipe stderr for diagnostics capture
	stderr, err := cmd.StderrPipe()
	if err != nil {
		utils.Error("CliBackend", "stderr pipe failed: "+err.Error())
		b.emitError(run.requestID, fmt.Errorf("failed to create stderr pipe: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	if err := cmd.Start(); err != nil {
		utils.Error("CliBackend", "process start failed: "+err.Error())
		b.emitError(run.requestID, fmt.Errorf("failed to start claude CLI: %w", err))
		b.emitExit(run.requestID, intPtr(1), nil, "")
		return
	}

	utils.Log("CliBackend", fmt.Sprintf("process started: pid=%d requestID=%s", cmd.Process.Pid, run.requestID))

	// Write initial prompt as NDJSON user message over stdin
	initMsg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role": "user",
			"content": []map[string]interface{}{
				{"type": "text", "text": opts.Prompt},
			},
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
			case *types.TaskCompleteEvent:
				if e.SessionID != "" {
					sessionID = e.SessionID
				}
				// Plan mode enrichment: when the CLI's result contains an
				// ExitPlanMode denial, inject our planFilePath (which the
				// CLI's wire format doesn't carry) and emit a
				// PlanProposalEvent{Kind:"exit"} before the TaskCompleteEvent
				// so consumers see the path before the run terminates.
				//
				// Per ADR-003 (state events vs workflow events): the model
				// calling ExitPlanMode is a *proposal*, not a confirmed mode
				// change. The engine must NOT emit a
				// PlanModeChangedEvent{Enabled:false} here — the mode flip is
				// deferred to the user-approval chokepoint. Instead it emits
				// the first-class workflow signal PlanProposalEvent{Kind:"exit"},
				// matching the API backend's interceptExitPlanMode path
				// (runloop_plan_mode_gates.go). The enriched ExitPlanMode
				// permission denial keeps flowing through engine_status /
				// task_complete for the existing card-render path.
				if run.planMode && run.planFilePath != "" {
					for i := range e.PermissionDenials {
						if e.PermissionDenials[i].ToolName == "ExitPlanMode" {
							e.PermissionDenials[i].ToolInput = map[string]any{
								"planFilePath": run.planFilePath,
							}
							b.emit(run.requestID, types.NormalizedEvent{
								Data: &types.PlanProposalEvent{
									Kind:         "exit",
									PlanFilePath: run.planFilePath,
									PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
								},
							})
							utils.Info("CliBackend", fmt.Sprintf("run=%s exit_tool emit plan_proposal kind=exit planFile=%s (mode change deferred to user approval, per ADR-003)", run.requestID, run.planFilePath))
							break
						}
					}
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

	utils.Log("CliBackend", fmt.Sprintf("process exited: pid=%d code=%d requestID=%s", cmd.Process.Pid, exitCode, run.requestID))

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
// FlushConversations is a no-op for CliBackend; the underlying CLI process
// owns its own persistence. RunBackend interface compliance.
func (b *CliBackend) FlushConversations() {}

func (b *CliBackend) WriteToStdin(requestID string, msg interface{}) error {
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

func (b *CliBackend) removeRun(requestID string) {
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

func (b *CliBackend) emit(runID string, event types.NormalizedEvent) {
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (b *CliBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.Info("CliBackend", fmt.Sprintf("emitExit: runID=%s code=%s signal=%s sessionID=%s", runID, codeStr, sigStr, sessionID))
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *CliBackend) emitError(runID string, err error) {
	utils.Error("CliBackend", fmt.Sprintf("emitError: runID=%s err=%s", runID, err.Error()))
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}
