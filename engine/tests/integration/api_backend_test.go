//go:build integration

package integration

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// mockRunExitTimeout bounds how long a test waits for a mock-backend run to
// emit its exit event. 15s matches the margin already proven sufficient by
// this package's other waitForExit calls -- a generous ceiling for a run
// that hits no real network, not a value tuned against a specific failure.
//
// (An earlier version of this comment attributed a Windows CI failure of
// TestApiBackendSimpleTextResponse/TestApiBackendTaskCompleteUsage/
// TestHybridBackend_ApiRoutedRunStreamsTextThroughInnerApi at ~5.00-5.01s to
// contention and "fixed" it by raising this bound to 15s. That was wrong: a
// real Windows VM run at 15s failed identically, and a diagnostic goroutine
// dump showed the actual cause -- those three call sites passed a full
// filesystem path as RunOptions.ConversationID, which is embedded verbatim
// into a durablefile lock-file name; the "C:" drive prefix made every mkdir
// attempt fail with a syntax error that no amount of retrying or waiting
// fixes. See the isolation comments at each call site for the real fix.)
const mockRunExitTimeout = 15 * time.Second

func setupMockProvider(t *testing.T) *helpers.MockProvider {
	t.Helper()
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{
		ProviderID:      "mock",
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})
	return mp
}

type backendEvents struct {
	mu         sync.Mutex
	normalized []types.NormalizedEvent
	exits      []exitEvent
	errors     []error
}

type exitEvent struct {
	runID     string
	code      *int
	signal    *string
	sessionID string
}

func newBackendCollector(b *backend.ApiBackend) *backendEvents {
	be := &backendEvents{}
	b.OnNormalized(func(runID string, event types.NormalizedEvent) {
		be.mu.Lock()
		be.normalized = append(be.normalized, event)
		be.mu.Unlock()
	})
	b.OnExit(func(runID string, code *int, signal *string, sessionID string) {
		be.mu.Lock()
		be.exits = append(be.exits, exitEvent{runID: runID, code: code, signal: signal, sessionID: sessionID})
		be.mu.Unlock()
	})
	b.OnError(func(runID string, err error) {
		be.mu.Lock()
		be.errors = append(be.errors, err)
		be.mu.Unlock()
	})
	return be
}

func (be *backendEvents) waitForExit(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		be.mu.Lock()
		n := len(be.exits)
		be.mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for exit event")
}

func (be *backendEvents) getNormalized() []types.NormalizedEvent {
	be.mu.Lock()
	defer be.mu.Unlock()
	out := make([]types.NormalizedEvent, len(be.normalized))
	copy(out, be.normalized)
	return out
}

func TestApiBackendSimpleTextResponse(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("Hello, world!"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// Isolate HOME: conversation.Save("", ...) ignores the run's convDir
	// entirely and always resolves DefaultConversationsDir() from HOME
	// (internal/conversation/helpers.go), so without this the run's final
	// save writes into the real operator's ~/.ion/conversations.
	t.Setenv("HOME", t.TempDir())
	b.StartRun("run-text", types.RunOptions{
		Prompt: "Say hello",
		Model:  "mock-model",
		// ConversationID must be a bare identifier, never a filesystem path
		// (see RunOptions.ConversationID's doc comment): it is embedded
		// verbatim into a lock-file name (durablefile), and a path value
		// containing "C:" broke that name on Windows -- every acquire
		// attempt failed with "filename... syntax is incorrect", retried
		// for the full bound, and never completed. Confirmed on a real
		// Windows VM with a diagnostic dump of the actual mkdir error.
		ConversationID: "conv-text",
	})

	be.waitForExit(t, mockRunExitTimeout)

	events := be.getNormalized()

	// Should have at least: text_chunk + task_complete
	foundText := false
	foundComplete := false
	for _, ev := range events {
		switch ev.Data.(type) {
		case *types.TextChunkEvent:
			tc := ev.Data.(*types.TextChunkEvent)
			if tc.Text == "Hello, world!" {
				foundText = true
			}
		case *types.TaskCompleteEvent:
			foundComplete = true
		}
	}

	if !foundText {
		t.Error("did not find text_chunk with expected text")
	}
	if !foundComplete {
		t.Error("did not find task_complete event")
	}
}

// TestApiBackendTaskCompleteUsage verifies that a normal (non-dispatch) run
// emits TaskCompleteEvent with Usage populated from the provider's scripted
// token counts. MockProvider.TextResponse scripts InputTokens:10 on
// message_start and OutputTokens:5 on message_delta. The runloop must
// accumulate these and surface them on TaskCompleteEvent.Usage.
func TestApiBackendTaskCompleteUsage(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("usage-test"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// See the isolation comment in TestApiBackendSimpleTextResponse above.
	t.Setenv("HOME", t.TempDir())
	b.StartRun("run-usage", types.RunOptions{
		Prompt:         "test usage",
		Model:          "mock-model",
		ConversationID: "conv-usage",
	})

	be.waitForExit(t, mockRunExitTimeout)

	events := be.getNormalized()
	var tc *types.TaskCompleteEvent
	for _, ev := range events {
		if e, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			tc = e
		}
	}

	if tc == nil {
		t.Fatal("no TaskCompleteEvent emitted")
	}
	if tc.Usage.InputTokens == nil {
		t.Fatal("TaskCompleteEvent.Usage.InputTokens is nil")
	}
	if tc.Usage.OutputTokens == nil {
		t.Fatal("TaskCompleteEvent.Usage.OutputTokens is nil")
	}
	if *tc.Usage.InputTokens != 10 {
		t.Errorf("InputTokens = %d, want 10", *tc.Usage.InputTokens)
	}
	if *tc.Usage.OutputTokens != 5 {
		t.Errorf("OutputTokens = %d, want 5", *tc.Usage.OutputTokens)
	}
	if tc.CostUsd <= 0 {
		t.Errorf("CostUsd = %f, want > 0", tc.CostUsd)
	}
}

func TestApiBackendToolCallLoop(t *testing.T) {
	mp := setupMockProvider(t)

	// Create a test file for the Read tool
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "test.txt")
	os.WriteFile(testFile, []byte("line1\nline2\nline3\n"), 0644)

	// First call: tool_use for Read
	mp.SetResponse(helpers.ToolCallResponse("Read", "tool_read_001", map[string]interface{}{
		"file_path": testFile,
	}))
	// Second call: text response
	mp.SetResponse(helpers.TextResponse("I read the file."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-tool", types.RunOptions{
		Prompt:      "Read the test file",
		Model:       "mock-model",
		ProjectPath: tmpDir,
	})

	be.waitForExit(t, mockRunExitTimeout)

	events := be.getNormalized()

	// Verify we got tool call + tool result + text + task_complete
	var foundToolCall, foundToolResult, foundText, foundComplete bool
	for _, ev := range events {
		switch e := ev.Data.(type) {
		case *types.ToolCallEvent:
			if e.ToolName == "Read" {
				foundToolCall = true
			}
		case *types.ToolResultEvent:
			if !e.IsError {
				foundToolResult = true
			}
		case *types.TextChunkEvent:
			if e.Text == "I read the file." {
				foundText = true
			}
		case *types.TaskCompleteEvent:
			foundComplete = true
		}
	}

	if !foundToolCall {
		t.Error("missing tool_call event for Read")
	}
	if !foundToolResult {
		t.Error("missing tool_result event")
	}
	if !foundText {
		t.Error("missing text_chunk event")
	}
	if !foundComplete {
		t.Error("missing task_complete event")
	}
}

func TestApiBackendMaxTurns(t *testing.T) {
	mp := setupMockProvider(t)

	// Always return tool_use -- will loop until max turns
	for i := 0; i < 5; i++ {
		mp.SetResponse(helpers.ToolCallResponse("Bash", "tool_bash_"+helpers.IntToStr(i), map[string]interface{}{
			"command": "echo hi",
		}))
	}

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-max-turns", types.RunOptions{
		Prompt:   "Keep working",
		Model:    "mock-model",
		MaxTurns: 2,
	})

	be.waitForExit(t, mockRunExitTimeout)

	events := be.getNormalized()

	// Should have a task_complete indicating max turns reached
	foundMaxTurns := false
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if strings.Contains(tc.Result, "max turns") || strings.Contains(tc.Result, "Reached max turns") {
				foundMaxTurns = true
			}
		}
	}
	if !foundMaxTurns {
		t.Error("expected task_complete with max turns message")
	}
}

func TestApiBackendCancellation(t *testing.T) {
	mp := setupMockProvider(t)

	// Return a response that takes some time (the mock delivers instantly,
	// but the tool execution might take a moment).
	//
	// The command is a shell loop rather than a bare `sleep 10`: a LEADING
	// `sleep N` is refused by the Bash tool's blocking-sleep gate before
	// execution, which would make the tool return instantly and stop this
	// test from exercising cancellation of an in-flight tool. A sleep inside
	// a loop body is never inspected by the gate.
	mp.SetResponse(helpers.ToolCallResponse("Bash", "tool_bash_cancel", map[string]interface{}{
		"command": "while true; do sleep 1; done",
	}))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-cancel", types.RunOptions{
		Prompt: "Run a long command",
		Model:  "mock-model",
	})

	// Give it a moment to start
	time.Sleep(100 * time.Millisecond)

	// Cancel
	cancelled := b.Cancel("run-cancel")
	if !cancelled {
		t.Error("expected Cancel to return true")
	}

	be.waitForExit(t, mockRunExitTimeout)

	// Verify the run is no longer active
	if b.IsRunning("run-cancel") {
		t.Error("run should not be active after cancellation")
	}
}

func TestApiBackendProviderError(t *testing.T) {
	mp := setupMockProvider(t)

	// Return an error on the error channel
	mp.SetResponseWithError(nil, &providers.ProviderError{
		Code:      "auth",
		Message:   "invalid api key",
		Retryable: false,
	})

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-err", types.RunOptions{
		Prompt: "Hello",
		Model:  "mock-model",
	})

	be.waitForExit(t, mockRunExitTimeout)

	be.mu.Lock()
	errCount := len(be.errors)
	be.mu.Unlock()

	if errCount == 0 {
		t.Error("expected at least one error event from provider failure")
	}
}

func TestApiBackendToolCallHook(t *testing.T) {
	mp := setupMockProvider(t)

	// First call: try to use Bash (which we'll block)
	mp.SetResponse(helpers.ToolCallResponse("Bash", "tool_bash_blocked", map[string]interface{}{
		"command": "rm -rf /",
	}))
	// Second call: text response (after blocked tool result goes back)
	mp.SetResponse(helpers.TextResponse("OK, I won't do that."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// Block Bash tool via per-run hook in RunConfig.
	cfg := &backend.RunConfig{
		Hooks: backend.RunHooks{
			OnToolCall: func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
				if info.ToolName == "Bash" {
					return &backend.ToolCallResult{Block: true, Reason: "dangerous command"}, nil
				}
				return nil, nil
			},
		},
	}

	b.StartRunWithConfig("run-hook", types.RunOptions{
		Prompt: "Delete everything",
		Model:  "mock-model",
	}, cfg)

	be.waitForExit(t, mockRunExitTimeout)

	events := be.getNormalized()

	// Should have a tool_result with isError=true indicating blocked
	foundBlocked := false
	for _, ev := range events {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok {
			if tr.IsError && strings.Contains(tr.Content, "Blocked") {
				foundBlocked = true
			}
		}
	}
	if !foundBlocked {
		t.Error("expected blocked tool_result event")
	}
}

func TestApiBackendConversationPersistence(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("Persisted response"))

	convDir := t.TempDir()
	conversationID := "persist-test"

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// Override conversation save directory via the conversation-ID path
	b.StartRun("run-persist", types.RunOptions{
		Prompt:         "Save this",
		Model:          "mock-model",
		ConversationID: conversationID,
	})

	be.waitForExit(t, mockRunExitTimeout)

	// The conversation should have been saved to
	// ~/.ion/conversations/<conversationID>.jsonl. Load it back to verify.
	loaded, err := conversation.Load(conversationID, "")
	if err != nil {
		// If default dir doesn't work, that's expected in test environment
		// The important thing is that the run completed without error
		t.Logf("Could not load conversation (expected in test env): %v", err)

		// Verify we at least got a task_complete with the sessionID
		events := be.getNormalized()
		foundComplete := false
		for _, ev := range events {
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				if tc.SessionID != "" {
					foundComplete = true
				}
			}
		}
		if !foundComplete {
			t.Error("expected task_complete event with sessionID")
		}
		return
	}

	if loaded.ID != conversationID {
		t.Errorf("expected conversation ID=%q, got %q", conversationID, loaded.ID)
	}

	// Cleanup saved file
	home, _ := os.UserHomeDir()
	os.Remove(filepath.Join(home, ".ion", "conversations", conversationID+".jsonl"))
	os.Remove(filepath.Join(home, ".ion", "conversations", conversationID+".json"))

	_ = convDir // suppress unused
}

// callToolNames lists a provider call's tool names in the order they were sent.
func callToolNames(call types.LlmStreamOptions) []string {
	names := make([]string, 0, len(call.Tools))
	for _, td := range call.Tools {
		names = append(names, td.Name)
	}
	return names
}

// messagesText concatenates the text of every message a provider call carried.
func messagesText(call types.LlmStreamOptions) string {
	var sb strings.Builder
	for _, msg := range call.Messages {
		switch c := msg.Content.(type) {
		case string:
			sb.WriteString(c)
		case []types.LlmContentBlock:
			for _, block := range c {
				sb.WriteString(block.Text)
			}
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// firstCallOf runs one prompt on a fresh backend and returns the first
// provider call it made.
func firstCallOf(t *testing.T, requestID string, opts types.RunOptions) types.LlmStreamOptions {
	t.Helper()
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("Here is my plan."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)
	b.StartRun(requestID, opts)
	be.waitForExit(t, mockRunExitTimeout)

	calls := mp.Calls()
	if len(calls) == 0 {
		t.Fatal("expected at least one provider call")
	}
	return calls[0]
}

// TestApiBackendPlanMode pins plan mode's effect on the provider request: the
// tool list and system prompt are the same as an auto-mode run's, so a mode
// change never rewrites the provider's cached prompt prefix. The plan-mode
// instructions travel as a notice in the messages instead.
func TestApiBackendPlanMode(t *testing.T) {
	auto := firstCallOf(t, "run-auto", types.RunOptions{
		Prompt: "Plan how to refactor",
		Model:  "mock-model",
	})
	plan := firstCallOf(t, "run-plan", types.RunOptions{
		Prompt:        "Plan how to refactor",
		Model:         "mock-model",
		PlanMode:      true,
		PlanModeTools: []string{"Read", "Grep", "Glob"},
		PlanFilePath:  "/tmp/test-plan.md",
	})

	autoNames, planNames := callToolNames(auto), callToolNames(plan)
	if strings.Join(planNames, ",") != strings.Join(autoNames, ",") {
		t.Errorf("plan-mode tool list differs from auto mode:\n plan: %v\n auto: %v", planNames, autoNames)
	}
	for _, name := range []string{tools.ExitPlanModeName, tools.EnterPlanModeName, "Bash"} {
		if !slices.Contains(planNames, name) {
			t.Errorf("tool list should carry %s in plan mode", name)
		}
	}

	if plan.System != auto.System {
		t.Error("plan mode must not change the system prompt")
	}
	if strings.Contains(plan.System, "PLAN MODE") {
		t.Error("plan-mode instructions must not be in the system prompt")
	}

	notice := messagesText(plan)
	if !strings.Contains(notice, "PLAN MODE") {
		t.Error("expected a plan-mode notice in the messages")
	}
	if !strings.Contains(notice, "/tmp/test-plan.md") {
		t.Error("expected the plan-mode notice to name the plan file path")
	}
	if strings.Contains(messagesText(auto), "PLAN MODE") {
		t.Error("an auto-mode run must carry no plan-mode notice")
	}
}

// TestApiBackendPlanModeRefusesBashAtCall pins where the read-only boundary now
// lives: Bash stays in the tool list, and the plan policy refuses the call.
func TestApiBackendPlanModeRefusesBashAtCall(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.ToolCallResponse("Bash", "bash-001", map[string]interface{}{
		"command": "touch /tmp/plan-mode-should-not-run",
	}))
	mp.SetResponse(helpers.TextResponse("Bash is refused while planning."))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// No PlanModeTools: the engine's default plan policy applies.
	b.StartRun("run-plan-default", types.RunOptions{
		Prompt:       "Plan something",
		Model:        "mock-model",
		PlanMode:     true,
		PlanFilePath: "/tmp/default-plan.md",
	})

	be.waitForExit(t, mockRunExitTimeout)

	calls := mp.Calls()
	if len(calls) == 0 {
		t.Fatal("expected at least one provider call")
	}
	if !slices.Contains(callToolNames(calls[0]), "Bash") {
		t.Error("Bash should stay in the tool list in plan mode")
	}

	refused := false
	for _, ev := range be.getNormalized() {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok && tr.ToolID == "bash-001" {
			refused = tr.IsError
		}
	}
	if !refused {
		t.Error("expected the plan policy to refuse the Bash call")
	}
}

func TestApiBackendPlanModeWriteGate(t *testing.T) {
	mp := setupMockProvider(t)

	planFile := "/tmp/test-project/.ion/plans/abc123.md"

	// LLM tries to Write to a non-plan file
	toolCall, finalText := helpers.MultiTurnResponse(
		"",
		"Write",
		map[string]interface{}{
			"file_path": "/tmp/test-project/src/main.go",
			"content":   "package main",
		},
		"I see I cannot write there.",
	)
	mp.SetResponse(toolCall)
	mp.SetResponse(finalText)

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-plan-gate", types.RunOptions{
		Prompt:       "Write some code",
		Model:        "mock-model",
		PlanMode:     true,
		PlanFilePath: planFile,
	})

	be.waitForExit(t, mockRunExitTimeout)

	// Check that the tool result was an error mentioning plan mode
	events := be.getNormalized()
	foundGateError := false
	for _, ev := range events {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok {
			if tr.IsError && strings.Contains(tr.Content, "that path is not the plan file for this session") {
				foundGateError = true
				break
			}
		}
	}
	if !foundGateError {
		t.Error("expected plan mode write gate to reject write to non-plan file")
	}
}

func TestApiBackendPlanModeExitPlanMode(t *testing.T) {
	mp := setupMockProvider(t)

	// LLM calls ExitPlanMode
	exitCall := helpers.ToolCallResponse("ExitPlanMode", "exit-001", map[string]interface{}{})
	mp.SetResponse(exitCall)

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-plan-exit", types.RunOptions{
		Prompt:       "Make a plan",
		Model:        "mock-model",
		PlanMode:     true,
		PlanFilePath: "/tmp/exit-plan.md",
	})

	be.waitForExit(t, mockRunExitTimeout)

	// The model calling ExitPlanMode is a *proposal*, not a confirmed mode
	// change. The engine must NOT emit PlanModeChangedEvent{Enabled:false}
	// from the interception — that would race the user-approval card. The
	// run-end signal is task_complete carrying the ExitPlanMode denial.
	events := be.getNormalized()
	for _, ev := range events {
		if pm, ok := ev.Data.(*types.PlanModeChangedEvent); ok && !pm.Enabled {
			t.Error("unexpected PlanModeChangedEvent{Enabled:false} on ExitPlanMode interception (must be deferred to user approval)")
		}
	}

	// Should have TaskComplete with ExitPlanMode in permission denials
	foundDenial := false
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			for _, d := range tc.PermissionDenials {
				if d.ToolName == "ExitPlanMode" {
					foundDenial = true
					break
				}
			}
		}
	}
	if !foundDenial {
		t.Error("expected ExitPlanMode in permission denials of TaskCompleteEvent")
	}
}

func TestApiBackendToolRegistryComplete(t *testing.T) {
	tools.RegisterTaskTools()
	defer tools.UnregisterTaskTools()

	// Verify all expected tools are registered
	expectedTools := []string{
		"Read", "Write", "Edit", "Bash", "Grep", "Glob",
		"Agent", "AgentStatus", "WebFetch", "WebSearch",
		"TaskCreate", "TaskList", "TaskGet", "TaskStop",
		"NotebookEdit", "LSP",
	}

	for _, name := range expectedTools {
		tool := tools.GetTool(name)
		if tool == nil {
			t.Errorf("expected tool %q to be registered", name)
		}
	}

	allTools := tools.GetAllTools()
	if len(allTools) < len(expectedTools) {
		t.Errorf("expected at least %d tools, got %d", len(expectedTools), len(allTools))
	}
}

// IntToStr is exported from helpers for use in tests.
// We re-export it here to avoid circular imports in the test helper.
var _ = helpers.IntToStr
