//go:build e2e

package e2e

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// cliEventCollector collects normalized events from a CliBackend run.
type cliEventCollector struct {
	mu         sync.Mutex
	normalized []types.NormalizedEvent
	exits      []cliExitInfo
	errors     []error
}

type cliExitInfo struct {
	code      *int
	signal    *string
	sessionID string
}

func newCliEventCollector(b *backend.ClaudeCodeBackend) *cliEventCollector {
	ec := &cliEventCollector{}
	b.OnNormalized(func(runID string, event types.NormalizedEvent) {
		ec.mu.Lock()
		ec.normalized = append(ec.normalized, event)
		ec.mu.Unlock()
	})
	b.OnExit(func(runID string, code *int, signal *string, sessionID string) {
		ec.mu.Lock()
		ec.exits = append(ec.exits, cliExitInfo{code, signal, sessionID})
		ec.mu.Unlock()
	})
	b.OnError(func(runID string, err error) {
		ec.mu.Lock()
		ec.errors = append(ec.errors, err)
		ec.mu.Unlock()
	})
	return ec
}

func (ec *cliEventCollector) waitForExit(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ec.mu.Lock()
		n := len(ec.exits)
		ec.mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("timed out waiting for CLI exit event")
}

func (ec *cliEventCollector) getNormalized() []types.NormalizedEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]types.NormalizedEvent, len(ec.normalized))
	copy(out, ec.normalized)
	return out
}

func (ec *cliEventCollector) getErrors() []error {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]error, len(ec.errors))
	copy(out, ec.errors)
	return out
}

func (ec *cliEventCollector) getExits() []cliExitInfo {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]cliExitInfo, len(ec.exits))
	copy(out, ec.exits)
	return out
}

// ─── Test 1: CliBackend simple prompt ───────────────────────────────────────
//
// Sanity baseline: a bare CliBackend runs a simple prompt via the Claude CLI
// using OAuth (no API key), receives text events, and exits with code 0.
// This confirms the Claude CLI is available and authenticated.
func TestLiveCliBackendSimplePrompt(t *testing.T) {
	b := backend.NewClaudeCodeBackend()
	ec := newCliEventCollector(b)

	b.StartRun("cli-simple", types.RunOptions{
		Prompt:      "What is 2+2? Reply with just the number, nothing else.",
		MaxTurns:    1,
		ProjectPath: t.TempDir(),
	})

	ec.waitForExit(t, 60*time.Second)

	// No errors
	errs := ec.getErrors()
	if len(errs) > 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}

	// Exit code 0
	exits := ec.getExits()
	if len(exits) == 0 {
		t.Fatal("no exit event received")
	}
	if exits[0].code == nil || *exits[0].code != 0 {
		codeStr := "nil"
		if exits[0].code != nil {
			codeStr = string(rune(*exits[0].code + '0'))
		}
		t.Fatalf("expected exit code 0, got %s", codeStr)
	}

	// Received text events with response containing "4"
	events := ec.getNormalized()
	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}
	if !strings.Contains(fullText.String(), "4") {
		t.Errorf("expected response to contain '4', got: %q", fullText.String())
	}

	// Got a TaskCompleteEvent
	foundComplete := false
	for _, ev := range events {
		if _, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			foundComplete = true
		}
	}
	if !foundComplete {
		t.Error("did not receive task_complete event")
	}

	t.Logf("CLI simple prompt OK: response=%q", strings.TrimSpace(fullText.String()))
}

// ─── Test 2: CliBackend child via newChildBackend factory ───────────────────
//
// Verifies that a Manager with CliBackend parent creates a CliBackend child
// via newChildBackend(), and the child actually runs a real prompt via the
// Claude CLI, produces text output, and exits cleanly.
func TestLiveCliBackendChildFactory(t *testing.T) {
	parentBackend := backend.NewClaudeCodeBackend()
	mgr := session.NewManager(parentBackend)

	// The factory should return a CliBackend
	child := mgr.TestNewChildBackend()
	cliChild, ok := child.(*backend.ClaudeCodeBackend)
	if !ok {
		t.Fatalf("expected *CliBackend child, got %T", child)
	}

	// Run a real prompt on the child
	ec := newCliEventCollector(cliChild)

	cliChild.StartRun("child-factory", types.RunOptions{
		Prompt:      "What is 3+5? Reply with just the number.",
		MaxTurns:    1,
		ProjectPath: t.TempDir(),
	})

	ec.waitForExit(t, 60*time.Second)

	errs := ec.getErrors()
	if len(errs) > 0 {
		t.Fatalf("child errors: %v", errs)
	}

	exits := ec.getExits()
	if len(exits) == 0 || exits[0].code == nil || *exits[0].code != 0 {
		t.Fatal("child did not exit cleanly")
	}

	events := ec.getNormalized()
	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}
	if !strings.Contains(fullText.String(), "8") {
		t.Errorf("expected child response to contain '8', got: %q", fullText.String())
	}

	t.Logf("CLI child factory OK: response=%q", strings.TrimSpace(fullText.String()))
}

// ─── Test 3: DispatchAgent via extension context (the #37 fix) ──────────────
//
// This is the core issue #37 reproduction. Creates a Manager with CliBackend,
// starts a session, wires an extension that calls ctx.DispatchAgent, and
// verifies the child agent runs to completion via the CLI subprocess (not API).
//
// Before the fix, this would fail with "no API key found for provider
// anthropic" because DispatchAgent hardcoded NewApiBackend().
func TestLiveCliBackendDispatchAgent(t *testing.T) {
	parentBackend := backend.NewClaudeCodeBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-dispatch",
		WorkingDirectory: t.TempDir(),
	}

	if _, err := mgr.StartSession("e2e-da", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-da") })

	// Collect events emitted by the manager
	var mu sync.Mutex
	var managerEvents []types.EngineEvent
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		mu.Lock()
		managerEvents = append(managerEvents, ev)
		mu.Unlock()
	})

	// Create an extension tool that calls ctx.DispatchAgent
	host := extension.NewHost()
	sdk := host.SDK()

	var dispatchResult *extension.DispatchAgentResult
	var dispatchErr error
	dispatchDone := make(chan struct{})

	sdk.RegisterTool(extension.ToolDefinition{
		Name:        "trigger_dispatch",
		Description: "calls DispatchAgent to spawn a CLI child",
		Parameters:  map[string]interface{}{"type": "object"},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			defer close(dispatchDone)
			if ctx.DispatchAgent == nil {
				return &types.ToolResult{Content: "DispatchAgent not wired", IsError: true}, nil
			}
			dispatchResult, dispatchErr = ctx.DispatchAgent(extension.DispatchAgentOpts{
				Name: "e2e-child",
				Task: "What is 7*6? Reply with just the number, nothing else.",
			})
			return &types.ToolResult{Content: "dispatched"}, nil
		},
	})

	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup("e2e-da", group)

	// Get the wired context and invoke the tool
	ctx := mgr.TestNewExtContext("e2e-da")
	if ctx == nil {
		t.Fatal("TestNewExtContext returned nil")
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	// Execute the tool — this calls DispatchAgent which spawns a CliBackend child
	_, err := tools[0].Execute(map[string]interface{}{}, ctx)
	if err != nil {
		t.Fatalf("tool Execute: %v", err)
	}

	// Wait for dispatch to finish (child runs a real CLI prompt)
	select {
	case <-dispatchDone:
	case <-time.After(120 * time.Second):
		t.Fatal("DispatchAgent timed out after 120s")
	}

	// Verify no dispatch error
	if dispatchErr != nil {
		// THE BUG: if this says "no API key found", the fix didn't work
		if strings.Contains(dispatchErr.Error(), "API key") || strings.Contains(dispatchErr.Error(), "api key") {
			t.Fatalf("REGRESSION: DispatchAgent used ApiBackend instead of CliBackend: %s", dispatchErr)
		}
		t.Fatalf("DispatchAgent error: %v", dispatchErr)
	}

	if dispatchResult == nil {
		t.Fatal("DispatchAgent returned nil result")
	}

	// Exit code must be 0
	if dispatchResult.ExitCode != 0 {
		t.Fatalf("child exit code %d, output: %s", dispatchResult.ExitCode, dispatchResult.Output)
	}

	// Output should contain "42"
	if !strings.Contains(dispatchResult.Output, "42") {
		t.Errorf("expected child output to contain '42', got: %q", dispatchResult.Output)
	}

	t.Logf("DispatchAgent OK: exitCode=%d output=%q cost=%.6f elapsed=%.2fs",
		dispatchResult.ExitCode, dispatchResult.Output,
		dispatchResult.Cost, dispatchResult.Elapsed)
}

// ─── Test 4: ion_agent tool via MCP sidecar (the #37 agent-spec gap) ────────
//
// Creates a Manager with CliBackend, wires the agent tool server, registers
// an agent spec, then calls the ion_agent tool handler directly to verify
// the full spec resolution → child CLI spawn → result pipeline.
//
// This verifies Part D of the fix: the engine's agent-spec system is
// reachable for CliBackend sessions via the MCP ToolServer.
func TestLiveCliBackendIonAgentTool(t *testing.T) {
	parentBackend := backend.NewClaudeCodeBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-ion-agent",
		WorkingDirectory: t.TempDir(),
	}

	if _, err := mgr.StartSession("e2e-ia", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-ia") })

	// Register an agent spec (simulates ~/.ion/agents/math-helper.md)
	mgr.TestRegisterAgentSpec("e2e-ia", types.AgentSpec{
		Name:         "math-helper",
		SystemPrompt: "You are a math helper. Always respond with just the numeric answer, nothing else.",
		Tools:        []string{"Read"},
	})

	// Wire the agent tool server to get the handler registered
	opts := types.RunOptions{}
	mgr.TestWireAgentToolServer("e2e-ia", &opts)

	if opts.McpConfig == "" {
		t.Fatal("wireAgentToolServer did not set McpConfig")
	}

	// Get the tool handler and call it directly (simulates what the CLI
	// subprocess would do when invoking mcp__ion-extensions__ion_agent)
	handler := mgr.TestBuildAgentToolHandler("e2e-ia")
	if handler == nil {
		t.Fatal("TestBuildAgentToolHandler returned nil")
	}

	result, err := handler(map[string]interface{}{
		"prompt": "What is 12*12? Reply with just the number.",
		"name":   "math-helper",
	})
	if err != nil {
		t.Fatalf("ion_agent handler error: %v", err)
	}

	if result.IsError {
		t.Fatalf("ion_agent returned error: %s", result.Content)
	}

	if !strings.Contains(result.Content, "144") {
		t.Errorf("expected result to contain '144', got: %q", result.Content)
	}

	t.Logf("ion_agent tool OK: result=%q", result.Content)
}

// ─── Test 5: CliBackend SendPrompt full pipeline ────────────────────────────
//
// End-to-end test through the Manager's SendPrompt path with a CliBackend.
// This exercises the full dispatch pipeline: buildRunOptions, wireToolServer,
// wireAgentToolServer, fireBeforePromptCli, and the CliBackend.StartRun.
func TestLiveCliBackendSendPrompt(t *testing.T) {
	parentBackend := backend.NewClaudeCodeBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-sendprompt",
		WorkingDirectory: t.TempDir(),
	}

	if _, err := mgr.StartSession("e2e-sp", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-sp") })

	// Collect events
	var mu sync.Mutex
	var events []types.EngineEvent
	done := make(chan struct{})

	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()

		// The run is done when we see engine_status with state=idle after running
		if ev.Type == "engine_status" && ev.Fields != nil && ev.Fields.State == "idle" && ev.Fields.SessionID != "" {
			select {
			case <-done:
			default:
				close(done)
			}
		}
	})

	// Send a prompt through the full pipeline
	if err := mgr.SendPrompt("e2e-sp", "What is 9+10? Reply with just the number.", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	// Wait for completion
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("SendPrompt timed out after 60s")
	}

	mu.Lock()
	allEvents := make([]types.EngineEvent, len(events))
	copy(allEvents, events)
	mu.Unlock()

	// Should have text_delta events
	var fullText strings.Builder
	for _, ev := range allEvents {
		if ev.Type == "engine_text_delta" {
			fullText.WriteString(ev.TextDelta)
		}
	}

	if !strings.Contains(fullText.String(), "19") {
		t.Errorf("expected response containing '19', got: %q", fullText.String())
	}

	// Should NOT have any engine_error events
	for _, ev := range allEvents {
		if ev.Type == "engine_error" {
			t.Errorf("unexpected engine_error: %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	// Should NOT have engine_dead
	for _, ev := range allEvents {
		if ev.Type == "engine_dead" {
			t.Errorf("unexpected engine_dead event (exit code: %v)", ev.ExitCode)
		}
	}

	t.Logf("SendPrompt OK: response=%q", strings.TrimSpace(fullText.String()))
}
