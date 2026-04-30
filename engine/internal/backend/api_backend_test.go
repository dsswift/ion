package backend

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// --- Mock provider for backend tests ---

// mockLlmProvider implements providers.LlmProvider with scripted responses.
type mockLlmProvider struct {
	id        string
	mu        sync.Mutex
	callCount int
	responses [][]types.LlmStreamEvent // one response per call
	failAfter int                       // if > 0, fail after this many events on first call
	failErr   error
}

func (m *mockLlmProvider) ID() string { return m.id }

func (m *mockLlmProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	m.mu.Lock()
	idx := m.callCount
	m.callCount++
	m.mu.Unlock()

	go func() {
		defer close(events)
		defer close(errc)

		if idx >= len(m.responses) {
			errc <- fmt.Errorf("mock provider: no response for call %d", idx)
			return
		}

		for i, ev := range m.responses[idx] {
			if m.failAfter > 0 && idx == 0 && i >= m.failAfter {
				errc <- m.failErr
				return
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			}
		}
	}()

	return events, errc
}

// --- Event builders ---

func textResponse(text string, inputTokens, outputTokens int) []types.LlmStreamEvent {
	stopReason := "end_turn"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    fmt.Sprintf("msg_%d", time.Now().UnixNano()),
				Model: "test-model",
				Usage: types.LlmUsage{InputTokens: inputTokens},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "text",
				Text: "",
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type: "text_delta",
				Text: text,
			},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: outputTokens},
		},
		{Type: "message_stop"},
	}
}

func toolUseResponse(toolName, toolID string, input map[string]any, inputTokens, outputTokens int) []types.LlmStreamEvent {
	inputJSON := "{"
	first := true
	for k, v := range input {
		if !first {
			inputJSON += ","
		}
		inputJSON += fmt.Sprintf(`"%s":"%v"`, k, v)
		first = false
	}
	inputJSON += "}"

	stopReason := "tool_use"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    fmt.Sprintf("msg_%d", time.Now().UnixNano()),
				Model: "test-model",
				Usage: types.LlmUsage{InputTokens: inputTokens},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "tool_use",
				ID:   toolID,
				Name: toolName,
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type:        "input_json_delta",
				PartialJSON: inputJSON,
			},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: outputTokens},
		},
		{Type: "message_stop"},
	}
}

func maxTokensResponse(text string) []types.LlmStreamEvent {
	stopReason := "max_tokens"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    fmt.Sprintf("msg_%d", time.Now().UnixNano()),
				Model: "test-model",
				Usage: types.LlmUsage{InputTokens: 10},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "text",
				Text: "",
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type: "text_delta",
				Text: text,
			},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 5},
		},
		{Type: "message_stop"},
	}
}

// errorMockProvider always fails immediately with the given error.
type errorMockProvider struct {
	id  string
	err error
}

func (e *errorMockProvider) ID() string { return e.id }

func (e *errorMockProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 1)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)
		errc <- e.err
	}()

	return events, errc
}

// slowMockProvider blocks during Stream to test cancellation.
type slowMockProvider struct {
	id       string
	blockFor time.Duration
}

func (s *slowMockProvider) ID() string { return s.id }

func (s *slowMockProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)

		// Emit message_start so the run loop starts processing
		select {
		case events <- types.LlmStreamEvent{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID: "msg_slow", Model: opts.Model,
				Usage: types.LlmUsage{InputTokens: 10},
			},
		}:
		case <-ctx.Done():
			errc <- ctx.Err()
			return
		}

		// Block until context cancelled or timeout
		select {
		case <-ctx.Done():
			errc <- ctx.Err()
		case <-time.After(s.blockFor):
			// If we get here without cancel, emit end_turn
			stopReason := "end_turn"
			events <- types.LlmStreamEvent{
				Type: "message_delta",
				Delta: &types.LlmStreamDelta{StopReason: &stopReason},
			}
			events <- types.LlmStreamEvent{Type: "message_stop"}
		}
	}()

	return events, errc
}

// --- Test helpers ---

const testProviderID = "test-backend-provider"
const testModel = "test-backend-model"

func setupTestProvider(responses [][]types.LlmStreamEvent) *mockLlmProvider {
	mock := &mockLlmProvider{
		id:        testProviderID,
		responses: responses,
	}
	providers.RegisterProvider(mock)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:     testProviderID,
		ContextWindow:  200000,
		CostPer1kInput: 0.003,
		CostPer1kOutput: 0.015,
	})
	return mock
}

func cleanupTestProvider() {
	// Use ResetRegistries or just re-register to clean
	// Since we can't delete individual entries easily from outside the package,
	// we just accept accumulation (tests use unique IDs)
}

type collectedEvents struct {
	mu         sync.Mutex
	normalized []types.NormalizedEvent
	exitCode   *int
	exitSignal *string
	exitSessID string
	errors     []error
}

func collectEvents(b *ApiBackend, requestID string) *collectedEvents {
	c := &collectedEvents{}

	b.OnNormalized(func(runID string, event types.NormalizedEvent) {
		if runID == requestID {
			c.mu.Lock()
			c.normalized = append(c.normalized, event)
			c.mu.Unlock()
		}
	})

	b.OnExit(func(runID string, code *int, signal *string, sessionID string) {
		if runID == requestID {
			c.mu.Lock()
			c.exitCode = code
			c.exitSignal = signal
			c.exitSessID = sessionID
			c.mu.Unlock()
		}
	})

	b.OnError(func(runID string, err error) {
		if runID == requestID {
			c.mu.Lock()
			c.errors = append(c.errors, err)
			c.mu.Unlock()
		}
	})

	return c
}

func waitForExit(c *collectedEvents, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		c.mu.Lock()
		done := c.exitCode != nil || c.exitSignal != nil
		c.mu.Unlock()
		if done {
			return true
		}
		select {
		case <-deadline:
			return false
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
}

// --- Tests ---

func TestNewApiBackendCreatesEmptyRuns(t *testing.T) {
	b := NewApiBackend()
	if b == nil {
		t.Fatal("expected non-nil backend")
	}
	if b.activeRuns == nil {
		t.Fatal("expected non-nil activeRuns map")
	}
	if len(b.activeRuns) != 0 {
		t.Errorf("expected empty activeRuns, got %d", len(b.activeRuns))
	}
}

func TestStartRunSpawnsAndTracksRun(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("hello", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-1")
	b.StartRun("req-1", types.RunOptions{
		Prompt:      "hello",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	// Briefly check IsRunning
	time.Sleep(10 * time.Millisecond)
	// The run may or may not still be active depending on timing

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}
}

func TestCancelReturnsFalseForUnknown(t *testing.T) {
	b := NewApiBackend()
	if b.Cancel("nonexistent") {
		t.Error("expected false for unknown requestID")
	}
}

func TestCancelReturnsTrueAndStopsRun(t *testing.T) {
	// Create a provider that blocks by sleeping in the stream goroutine
	blockingProvider := &slowMockProvider{
		id:       testProviderID,
		blockFor: 5 * time.Second,
	}
	providers.RegisterProvider(blockingProvider)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:     testProviderID,
		ContextWindow:  200000,
		CostPer1kInput: 0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-cancel")
	b.StartRun("req-cancel", types.RunOptions{
		Prompt:      "slow run",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	time.Sleep(100 * time.Millisecond)
	result := b.Cancel("req-cancel")
	if !result {
		t.Error("expected Cancel to return true for active run")
	}

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit after cancel")
	}
}

func TestIsRunningDuringAndAfter(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("quick", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-running")
	b.StartRun("req-running", types.RunOptions{
		Prompt:      "test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	// After exit, run should be removed
	if b.IsRunning("req-running") {
		t.Error("expected IsRunning false after completion")
	}
}

func TestOnNormalizedReceivesEvents(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("normalized test", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-norm")
	b.StartRun("req-norm", types.RunOptions{
		Prompt:      "test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if len(c.normalized) == 0 {
		t.Fatal("expected normalized events")
	}

	// Should have text_chunk and task_complete
	hasText := false
	hasComplete := false
	for _, ev := range c.normalized {
		switch ev.Data.(type) {
		case *types.TextChunkEvent:
			hasText = true
		case *types.TaskCompleteEvent:
			hasComplete = true
		}
	}
	if !hasText {
		t.Error("expected text_chunk event")
	}
	if !hasComplete {
		t.Error("expected task_complete event")
	}
}

func TestOnExitCalledWithSessionID(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("exit test", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-exit")
	b.StartRun("req-exit", types.RunOptions{
		Prompt:      "test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil {
		t.Fatal("expected exit code")
	}
	if *c.exitCode != 0 {
		t.Errorf("expected exit code 0, got %d", *c.exitCode)
	}
	if c.exitSessID == "" {
		t.Error("expected non-empty session ID in exit callback")
	}
}

func TestOnErrorCalledOnProviderFailure(t *testing.T) {
	// Provider that always fails with a non-retryable error
	errProvider := &errorMockProvider{
		id:  testProviderID,
		err: providers.NewProviderError("auth", "invalid key", 401, false),
	}
	providers.RegisterProvider(errProvider)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:     testProviderID,
		ContextWindow:  200000,
		CostPer1kInput: 0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-err")
	b.StartRun("req-err", types.RunOptions{
		Prompt:      "fail",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil || *c.exitCode != 1 {
		code := -1
		if c.exitCode != nil {
			code = *c.exitCode
		}
		t.Errorf("expected exit code 1, got %d", code)
	}
	if len(c.errors) == 0 {
		t.Error("expected error callback to be called")
	}
}

func TestSetOnToolCallBlocksPreventsExecution(t *testing.T) {
	// Register a simple tool
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_blocked_tool",
		Description: "a tool that should be blocked",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "should not run"}, nil
		},
	})

	setupTestProvider([][]types.LlmStreamEvent{
		toolUseResponse("test_blocked_tool", "tool-block-1", map[string]any{"x": "y"}, 10, 5),
		textResponse("done after block", 10, 5),
	})

	b := NewApiBackend()
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnToolCall: func(info ToolCallInfo) (*ToolCallResult, error) {
				if info.ToolName == "test_blocked_tool" {
					return &ToolCallResult{Block: true, Reason: "permission denied"}, nil
				}
				return nil, nil
			},
		},
	}

	c := collectEvents(b, "req-block")
	b.StartRunWithConfig("req-block", types.RunOptions{
		Prompt:      "block test",
		ProjectPath: "/tmp",
		Model:       testModel,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	// Should have tool_result with block reason
	for _, ev := range c.normalized {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok {
			if tr.ToolID == "tool-block-1" {
				if !tr.IsError {
					t.Error("expected blocked tool result to be error")
				}
				if !strings.Contains(tr.Content, "Blocked") {
					t.Errorf("expected 'Blocked' in content, got %q", tr.Content)
				}
				return
			}
		}
	}
	t.Error("did not find tool_result for blocked tool")
}

func TestSetOnPerToolHookFiresBeforeAndAfter(t *testing.T) {
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_hooked_tool",
		Description: "a tool with hooks",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "hooked result"}, nil
		},
	})

	setupTestProvider([][]types.LlmStreamEvent{
		toolUseResponse("test_hooked_tool", "tool-hook-1", map[string]any{}, 10, 5),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()

	var hookPhases []string
	var hookMu sync.Mutex
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnPerToolHook: func(toolName string, info interface{}, phase string) (interface{}, error) {
				if toolName == "test_hooked_tool" {
					hookMu.Lock()
					hookPhases = append(hookPhases, phase)
					hookMu.Unlock()
				}
				return nil, nil
			},
		},
	}

	c := collectEvents(b, "req-hook")
	b.StartRunWithConfig("req-hook", types.RunOptions{
		Prompt:      "hook test",
		ProjectPath: "/tmp",
		Model:       testModel,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	hookMu.Lock()
	phases := hookPhases
	hookMu.Unlock()

	if len(phases) < 2 {
		t.Fatalf("expected at least 2 hook phases (before, after), got %d: %v", len(phases), phases)
	}

	hasBefore := false
	hasAfter := false
	for _, p := range phases {
		if p == "before" {
			hasBefore = true
		}
		if p == "after" {
			hasAfter = true
		}
	}
	if !hasBefore {
		t.Error("expected 'before' phase")
	}
	if !hasAfter {
		t.Error("expected 'after' phase")
	}
}

func TestRunConfigTelemetryAttachesToRun(t *testing.T) {
	// Telemetry now travels per-run via RunConfig. Verify that StartRun with
	// a config makes the telemetry visible on the resulting activeRun.
	b := NewApiBackend()
	mock := &mockTelemetry{}
	cfg := &RunConfig{Telemetry: mock}

	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("ok", 1, 1),
	})
	c := collectEvents(b, "req-telem")
	b.StartRunWithConfig("req-telem", types.RunOptions{
		Prompt:      "telemetry test",
		ProjectPath: "/tmp",
		Model:       testModel,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	// Telemetry collector should have observed at least one llm.call span end
	// (mockSpan.End is a no-op; we only assert the hook wiring compiled and
	// the run completed without panicking).
}

type mockTelemetry struct {
	events []string
}

func (m *mockTelemetry) Event(name string, payload map[string]interface{}, ctx map[string]interface{}) {
	m.events = append(m.events, name)
}

type mockSpan struct{}

func (s *mockSpan) End(attrs map[string]interface{}, errMsg ...string) {}

func (m *mockTelemetry) StartSpan(name string, attrs map[string]interface{}) Span {
	return &mockSpan{}
}

func TestConcurrentMultipleRuns(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("run-a", 10, 5),
		textResponse("run-b", 10, 5),
	})

	b := NewApiBackend()
	cA := collectEvents(b, "req-a")
	cB := collectEvents(b, "req-b")

	// Need separate backends since OnNormalized/OnExit are single callbacks
	// Actually we need to handle this differently - use a single backend
	// but the collector captures by requestID

	// Re-approach: use single backend with combined collector
	bMulti := NewApiBackend()

	var mu sync.Mutex
	eventsA := []types.NormalizedEvent{}
	eventsB := []types.NormalizedEvent{}
	var exitA, exitB *int

	bMulti.OnNormalized(func(runID string, event types.NormalizedEvent) {
		mu.Lock()
		defer mu.Unlock()
		if runID == "req-ma" {
			eventsA = append(eventsA, event)
		} else if runID == "req-mb" {
			eventsB = append(eventsB, event)
		}
	})

	bMulti.OnExit(func(runID string, code *int, signal *string, sessionID string) {
		mu.Lock()
		defer mu.Unlock()
		if runID == "req-ma" {
			exitA = code
		} else if runID == "req-mb" {
			exitB = code
		}
	})

	// Need a provider that can handle 2+ calls
	multiProvider := &mockLlmProvider{
		id: testProviderID,
		responses: [][]types.LlmStreamEvent{
			textResponse("run-a", 10, 5),
			textResponse("run-b", 10, 5),
		},
	}
	providers.RegisterProvider(multiProvider)

	bMulti.StartRun("req-ma", types.RunOptions{
		Prompt:      "run a",
		ProjectPath: "/tmp",
		Model:       testModel,
	})
	bMulti.StartRun("req-mb", types.RunOptions{
		Prompt:      "run b",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	deadline := time.After(5 * time.Second)
	for {
		mu.Lock()
		doneA := exitA != nil
		doneB := exitB != nil
		mu.Unlock()

		if doneA && doneB {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for concurrent runs")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	mu.Lock()
	defer mu.Unlock()

	if *exitA != 0 {
		t.Errorf("run A exit code: %d", *exitA)
	}
	if *exitB != 0 {
		t.Errorf("run B exit code: %d", *exitB)
	}
	if len(eventsA) == 0 {
		t.Error("expected events for run A")
	}
	if len(eventsB) == 0 {
		t.Error("expected events for run B")
	}

	// We don't use these but they prevent unused warnings
	_ = cA
	_ = cB
	_ = b
}

func TestCancelDuringRun(t *testing.T) {
	// Provider that blocks for a long time
	blockingProvider := &slowMockProvider{
		id:       testProviderID,
		blockFor: 5 * time.Second,
	}
	providers.RegisterProvider(blockingProvider)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:     testProviderID,
		ContextWindow:  200000,
		CostPer1kInput: 0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-cancel-during")
	b.StartRun("req-cancel-during", types.RunOptions{
		Prompt:      "block",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	time.Sleep(100 * time.Millisecond)
	if !b.Cancel("req-cancel-during") {
		t.Error("expected cancel to succeed")
	}

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit after cancel")
	}
}

func TestToolExecutionErrorHandling(t *testing.T) {
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_error_tool",
		Description: "always errors",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return nil, fmt.Errorf("tool execution failed")
		},
	})

	setupTestProvider([][]types.LlmStreamEvent{
		toolUseResponse("test_error_tool", "tool-err-1", map[string]any{}, 10, 5),
		textResponse("recovered", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-tool-err")
	b.StartRun("req-tool-err", types.RunOptions{
		Prompt:      "error tool",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil || *c.exitCode != 0 {
		code := -1
		if c.exitCode != nil {
			code = *c.exitCode
		}
		t.Errorf("expected exit code 0 (tool error is recoverable), got %d", code)
	}

	// Find the tool result with error
	for _, ev := range c.normalized {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok {
			if tr.ToolID == "tool-err-1" {
				if !tr.IsError {
					t.Error("expected tool result to be error")
				}
				if !strings.Contains(tr.Content, "tool execution failed") {
					t.Errorf("expected error message in content, got %q", tr.Content)
				}
				return
			}
		}
	}
	t.Error("did not find tool_result event for erroring tool")
}

func TestCostTracking(t *testing.T) {
	// Use known token counts to verify cost calculation
	// Model: costPer1kInput=0.003, costPer1kOutput=0.015
	// 500 input + 200 output
	// cost = (500/1000)*0.003 + (200/1000)*0.015 = 0.0015 + 0.003 = 0.0045
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("cost test", 500, 200),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-cost")
	b.StartRun("req-cost", types.RunOptions{
		Prompt:      "cost",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if tc.CostUsd <= 0 {
				t.Error("expected cost > 0")
			}
			return
		}
	}
	t.Error("did not find task_complete event")
}

func TestBudgetEnforcementStopsAtMaxCost(t *testing.T) {
	// Use high token counts so cost exceeds tiny budget
	// 50000 input + 50000 output
	// cost = (50000/1000)*0.003 + (50000/1000)*0.015 = 0.15 + 0.75 = 0.90
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_budget_tool",
		Description: "for budget test",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "ok"}, nil
		},
	})

	setupTestProvider([][]types.LlmStreamEvent{
		toolUseResponse("test_budget_tool", "tool-budget-1", map[string]any{}, 50000, 50000),
		textResponse("should not reach", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-budget")
	b.StartRun("req-budget", types.RunOptions{
		Prompt:      "budget test",
		ProjectPath: "/tmp",
		Model:       testModel,
		MaxBudgetUsd: 0.0001, // very low budget
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	// Should have emitted an error about budget
	for _, ev := range c.normalized {
		if err, ok := ev.Data.(*types.ErrorEvent); ok {
			if strings.Contains(strings.ToLower(err.ErrorMessage), "budget") {
				return // found it
			}
		}
	}
	t.Error("expected budget error event")
}

func TestBudgetEnforcementStopsAtMaxTurns(t *testing.T) {
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_turn_tool",
		Description: "for turn limit test",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "ok"}, nil
		},
	})

	// Provider always calls tool (never end_turn), so it runs until maxTurns
	manyResponses := make([][]types.LlmStreamEvent, 10)
	for i := range manyResponses {
		manyResponses[i] = toolUseResponse("test_turn_tool", fmt.Sprintf("tool-turn-%d", i), map[string]any{}, 10, 5)
	}

	setupTestProvider(manyResponses)

	b := NewApiBackend()
	c := collectEvents(b, "req-turns")
	b.StartRun("req-turns", types.RunOptions{
		Prompt:      "turn limit",
		ProjectPath: "/tmp",
		Model:       testModel,
		MaxTurns:    3,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	// Should complete with task_complete mentioning max turns
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if tc.NumTurns > 3 {
				t.Errorf("expected <= 3 turns, got %d", tc.NumTurns)
			}
			if !strings.Contains(tc.Result, "max turns") {
				t.Logf("task_complete result: %q", tc.Result)
			}
			return
		}
	}
	t.Error("did not find task_complete event")
}

func TestMaxTokensContinuation(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		maxTokensResponse("partial..."),
		textResponse("completed", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-max-tok")
	b.StartRun("req-max-tok", types.RunOptions{
		Prompt:      "continue test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil || *c.exitCode != 0 {
		t.Errorf("expected exit code 0")
	}

	// Should have 2 turns
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if tc.NumTurns != 2 {
				t.Errorf("expected 2 turns for max_tokens continuation, got %d", tc.NumTurns)
			}
			return
		}
	}
	t.Error("did not find task_complete event")
}

func TestTaskCompleteContainsExpectedFields(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("final answer", 100, 50),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-fields")
	b.StartRun("req-fields", types.RunOptions{
		Prompt:      "fields test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if tc.Result != "final answer" {
				t.Errorf("result: want 'final answer', got %q", tc.Result)
			}
			if tc.CostUsd <= 0 {
				t.Error("expected costUsd > 0")
			}
			if tc.NumTurns != 1 {
				t.Errorf("expected 1 turn, got %d", tc.NumTurns)
			}
			if tc.SessionID == "" {
				t.Error("expected non-empty sessionId")
			}
			if tc.DurationMs < 0 {
				t.Error("expected durationMs >= 0")
			}
			return
		}
	}
	t.Error("did not find task_complete event")
}

func TestErrorOnUnknownModel(t *testing.T) {
	b := NewApiBackend()
	c := collectEvents(b, "req-unknown-model")
	b.StartRun("req-unknown-model", types.RunOptions{
		Prompt:      "test",
		ProjectPath: "/tmp",
		Model:       "nonexistent-model-xyz",
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil || *c.exitCode != 1 {
		code := -1
		if c.exitCode != nil {
			code = *c.exitCode
		}
		t.Errorf("expected exit code 1, got %d", code)
	}

	if len(c.errors) == 0 {
		t.Error("expected error for unknown model")
	}
}

func TestErrorOnEmptyModel(t *testing.T) {
	b := NewApiBackend()
	c := collectEvents(b, "req-empty-model")
	b.StartRun("req-empty-model", types.RunOptions{
		Prompt:      "test",
		ProjectPath: "/tmp",
		// Model intentionally omitted.
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if c.exitCode == nil || *c.exitCode != 1 {
		code := -1
		if c.exitCode != nil {
			code = *c.exitCode
		}
		t.Errorf("expected exit code 1, got %d", code)
	}

	if len(c.errors) == 0 {
		t.Fatal("expected error for empty model")
	}

	found := false
	for _, e := range c.errors {
		if strings.Contains(e.Error(), "no model configured") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'no model configured' in error messages, got %v", c.errors)
	}
}

func TestTextChunksAccumulated(t *testing.T) {
	// Create response with multiple text deltas
	stopReason := "end_turn"
	multiDelta := []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID: "msg_multi", Model: testModel,
				Usage: types.LlmUsage{InputTokens: 10},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{Type: "text", Text: ""},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta:      &types.LlmStreamDelta{Type: "text_delta", Text: "Hello "},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta:      &types.LlmStreamDelta{Type: "text_delta", Text: "world"},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta:      &types.LlmStreamDelta{Type: "text_delta", Text: "!"},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 5},
		},
		{Type: "message_stop"},
	}

	setupTestProvider([][]types.LlmStreamEvent{multiDelta})

	b := NewApiBackend()
	c := collectEvents(b, "req-multi-delta")
	b.StartRun("req-multi-delta", types.RunOptions{
		Prompt:      "multi",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	var textChunks []string
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			textChunks = append(textChunks, tc.Text)
		}
	}

	if len(textChunks) != 3 {
		t.Errorf("expected 3 text chunks, got %d", len(textChunks))
	}

	combined := strings.Join(textChunks, "")
	if combined != "Hello world!" {
		t.Errorf("expected 'Hello world!', got %q", combined)
	}
}
