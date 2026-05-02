package session

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestHandleNormalizedEvent_TextChunk(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("ev", defaultConfig())
	_ = mgr.SendPrompt("ev", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hello"},
	})

	textEvents := ec.byType("engine_text_delta")
	if len(textEvents) == 0 {
		t.Fatal("expected engine_text_delta event")
	}
	if textEvents[0].event.TextDelta != "hello" {
		t.Errorf("expected text 'hello', got %q", textEvents[0].event.TextDelta)
	}
	if textEvents[0].key != "ev" {
		t.Errorf("expected key 'ev', got %q", textEvents[0].key)
	}
}

func TestHandleNormalizedEvent_ToolCall(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("tc", defaultConfig())
	_ = mgr.SendPrompt("tc", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool_123"},
	})

	toolEvents := ec.byType("engine_tool_start")
	if len(toolEvents) == 0 {
		t.Fatal("expected engine_tool_start event")
	}
	if toolEvents[0].event.ToolName != "Read" {
		t.Errorf("expected toolName 'Read', got %q", toolEvents[0].event.ToolName)
	}
	if toolEvents[0].event.ToolID != "tool_123" {
		t.Errorf("expected toolID 'tool_123', got %q", toolEvents[0].event.ToolID)
	}
}

func TestHandleNormalizedEvent_ToolCallUpdate(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("tcu", defaultConfig())
	_ = mgr.SendPrompt("tcu", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolCallUpdateEvent{ToolID: "tool_up1", PartialInput: `{"file_path":"/tmp/test`},
	})

	updateEvents := ec.byType("engine_tool_update")
	if len(updateEvents) == 0 {
		t.Fatal("expected engine_tool_update event")
	}
	if updateEvents[0].event.ToolID != "tool_up1" {
		t.Errorf("expected toolID 'tool_up1', got %q", updateEvents[0].event.ToolID)
	}
	if updateEvents[0].event.ToolPartialInput != `{"file_path":"/tmp/test` {
		t.Errorf("expected partialInput, got %q", updateEvents[0].event.ToolPartialInput)
	}
}

func TestHandleNormalizedEvent_ToolCallComplete(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("tcc", defaultConfig())
	_ = mgr.SendPrompt("tcc", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolCallCompleteEvent{Index: 5},
	})

	completeEvents := ec.byType("engine_tool_complete")
	if len(completeEvents) == 0 {
		t.Fatal("expected engine_tool_complete event")
	}
	if completeEvents[0].event.ToolIndex == nil || *completeEvents[0].event.ToolIndex != 5 {
		t.Errorf("expected ToolIndex 5, got %v", completeEvents[0].event.ToolIndex)
	}
}

func TestHandleNormalizedEvent_ToolResult(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("tr", defaultConfig())
	_ = mgr.SendPrompt("tr", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolResultEvent{ToolID: "tool_456", Content: "file contents", IsError: false},
	})

	toolEndEvents := ec.byType("engine_tool_end")
	if len(toolEndEvents) == 0 {
		t.Fatal("expected engine_tool_end event")
	}
	if toolEndEvents[0].event.ToolResult != "file contents" {
		t.Errorf("expected result 'file contents', got %q", toolEndEvents[0].event.ToolResult)
	}
}

func TestHandleNormalizedEvent_ToolResultError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("tre", defaultConfig())
	_ = mgr.SendPrompt("tre", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolResultEvent{ToolID: "tool_err", Content: "not found", IsError: true},
	})

	toolEndEvents := ec.byType("engine_tool_end")
	if len(toolEndEvents) == 0 {
		t.Fatal("expected engine_tool_end event")
	}
	if !toolEndEvents[0].event.ToolIsError {
		t.Error("expected ToolIsError=true")
	}
}

func TestHandleNormalizedEvent_TaskComplete(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("done", defaultConfig())
	_ = mgr.SendPrompt("done", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "All done", CostUsd: 0.05},
	})

	statusEvents := ec.byType("engine_status")
	found := false
	for _, e := range statusEvents {
		if e.event.Fields != nil && e.event.Fields.TotalCostUsd == 0.05 {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected engine_status with cost from TaskComplete")
	}
}

func TestHandleNormalizedEvent_ErrorEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("err", defaultConfig())
	_ = mgr.SendPrompt("err", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ErrorEvent{ErrorMessage: "something broke"},
	})

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error event")
	}
	if errEvents[0].event.EventMessage != "something broke" {
		t.Errorf("expected 'something broke', got %q", errEvents[0].event.EventMessage)
	}
}

func TestHandleNormalizedEvent_UsageEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("usage", defaultConfig())
	_ = mgr.SendPrompt("usage", "go", nil)

	keys := mb.startedKeys()
	in, out := 1000, 500
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &in, OutputTokens: &out}},
	})

	msgEndEvents := ec.byType("engine_message_end")
	if len(msgEndEvents) == 0 {
		t.Fatal("expected engine_message_end event")
	}
	if msgEndEvents[0].event.EndUsage == nil {
		t.Fatal("expected EndUsage to be set")
	}
	if msgEndEvents[0].event.EndUsage.InputTokens != 1000 {
		t.Errorf("expected inputTokens=1000, got %d", msgEndEvents[0].event.EndUsage.InputTokens)
	}
	if msgEndEvents[0].event.EndUsage.OutputTokens != 500 {
		t.Errorf("expected outputTokens=500, got %d", msgEndEvents[0].event.EndUsage.OutputTokens)
	}
}

func TestHandleNormalizedEvent_SessionDead(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("dead", defaultConfig())
	_ = mgr.SendPrompt("dead", "go", nil)

	keys := mb.startedKeys()
	code := 1
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.SessionDeadEvent{ExitCode: &code, StderrTail: []string{"panic"}},
	})

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event")
	}
	if deadEvents[0].event.ExitCode == nil || *deadEvents[0].event.ExitCode != 1 {
		t.Error("expected exitCode=1")
	}
	if len(deadEvents[0].event.StderrTail) == 0 || deadEvents[0].event.StderrTail[0] != "panic" {
		t.Error("expected stderrTail=['panic']")
	}
}

func TestHandleNormalizedEvent_NilDataReturnsError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("nildata", defaultConfig())
	_ = mgr.SendPrompt("nildata", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{Data: nil})

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error for nil event data")
	}
	if !strings.Contains(errEvents[0].event.EventMessage, "nil") {
		t.Errorf("expected message about nil, got %q", errEvents[0].event.EventMessage)
	}
}

func TestHandleNormalizedEvent_UnknownRunIDIgnored(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("s1", defaultConfig())

	// Emit event with a run ID that doesn't belong to any session
	initialCount := ec.count()
	mb.emitNormalized("unknown-run-id", types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "stray"},
	})

	// The initial count includes the start session status event.
	// No new events should appear.
	afterCount := ec.count()
	if afterCount != initialCount {
		t.Errorf("expected no new events for unknown run ID, got %d extra", afterCount-initialCount)
	}
}

// ---------------------------------------------------------------------------
// handleRunExit tests
// ---------------------------------------------------------------------------

func TestHandleRunExit_ClearsRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("exit", defaultConfig())
	_ = mgr.SendPrompt("exit", "go", nil)

	if !mgr.IsRunning("exit") {
		t.Fatal("should be running")
	}

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "conv-123")

	if mgr.IsRunning("exit") {
		t.Error("should no longer be running after exit")
	}
}

func TestHandleRunExit_SetsConversationID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("sessid", defaultConfig())
	_ = mgr.SendPrompt("sessid", "go", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "session-abc")

	// After exit, the conversationID should be set. We verify by checking
	// the internal session state directly (same package).
	mgr.mu.RLock()
	s := mgr.sessions["sessid"]
	cs := s.conversationID
	mgr.mu.RUnlock()

	if cs != "session-abc" {
		t.Errorf("expected conversationID='session-abc', got %q", cs)
	}

	// Also verify the next prompt passes the session ID through.
	// Sleep 1ms to avoid timestamp collision in request ID.
	time.Sleep(time.Millisecond)
	_ = mgr.SendPrompt("sessid", "follow up", nil)

	keys2 := mb.startedKeys()
	for _, k := range keys2 {
		if k != keys[0] {
			opts, _ := mb.getStarted(k)
			if opts.SessionID != "session-abc" {
				t.Errorf("expected sessionID 'session-abc', got %q", opts.SessionID)
			}
			return
		}
	}
	t.Error("could not find second run")
}

func TestHandleRunExit_EmitsIdleStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("exit-idle", defaultConfig())
	_ = mgr.SendPrompt("exit-idle", "go", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "")

	statuses := ec.byType("engine_status")
	found := false
	for _, e := range statuses {
		if e.event.Fields != nil && e.event.Fields.State == "idle" && e.event.Fields.Label == "exit-idle" {
			found = true
		}
	}
	if !found {
		t.Error("expected engine_status with state=idle after exit")
	}
}

func TestHandleRunExit_EmitsDeadWithCodeAndSignal(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("exit-dead", defaultConfig())
	_ = mgr.SendPrompt("exit-dead", "go", nil)

	keys := mb.startedKeys()
	code := 137
	signal := "SIGKILL"
	mb.emitExit(keys[0], &code, &signal, "")

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event")
	}
	if deadEvents[0].event.ExitCode == nil || *deadEvents[0].event.ExitCode != 137 {
		t.Error("expected exitCode=137")
	}
	if deadEvents[0].event.Signal == nil || *deadEvents[0].event.Signal != "SIGKILL" {
		t.Error("expected signal=SIGKILL")
	}
}

func TestHandleRunExit_NilCodeAndSignal_NoDeadEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("exit-nil", defaultConfig())
	_ = mgr.SendPrompt("exit-nil", "go", nil)

	keys := mb.startedKeys()
	mb.emitExit(keys[0], nil, nil, "")

	deadEvents := ec.byType("engine_dead")
	// With both code and signal nil, no engine_dead should be emitted
	// (only the idle status event is emitted)
	if len(deadEvents) != 0 {
		t.Errorf("expected no engine_dead event when code and signal are nil, got %d", len(deadEvents))
	}
}

// ---------------------------------------------------------------------------
// handleRunError tests
// ---------------------------------------------------------------------------

func TestHandleRunError_EmitsErrorEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("runerr", defaultConfig())
	_ = mgr.SendPrompt("runerr", "go", nil)

	// In production, ApiBackend.emitError emits a structured ErrorEvent
	// through the NormalizedEvent pipeline. Simulate that here.
	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{Data: &types.ErrorEvent{
		ErrorMessage: "provider timeout",
		IsError:      true,
		ErrorCode:    "timeout",
		Retryable:    true,
	}})

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error event")
	}
	if errEvents[0].event.EventMessage != "provider timeout" {
		t.Errorf("expected 'provider timeout', got %q", errEvents[0].event.EventMessage)
	}
	if errEvents[0].event.ErrorCode != "timeout" {
		t.Errorf("expected errorCode 'timeout', got %q", errEvents[0].event.ErrorCode)
	}
	if !errEvents[0].event.Retryable {
		t.Error("expected retryable to be true")
	}
}

func TestHandleRunError_UnknownRunIDIgnored(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("s", defaultConfig())
	initialCount := ec.count()

	mb.emitError("unknown-run", errors.New("stray error"))

	if ec.count() != initialCount {
		t.Error("expected no events for unknown run ID")
	}
}

// ---------------------------------------------------------------------------
// OnEvent tests
// ---------------------------------------------------------------------------

func TestOnEvent_NilCallbackNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	// No OnEvent registered
	_, _ = mgr.StartSession("s1", defaultConfig()) // emits an event -- should not panic
}

func TestOnEvent_ReplaceCallback(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var firstCount, secondCount int
	mgr.OnEvent(func(key string, event types.EngineEvent) { firstCount++ })
	_, _ = mgr.StartSession("s1", defaultConfig())

	mgr.OnEvent(func(key string, event types.EngineEvent) { secondCount++ })
	_, _ = mgr.StartSession("s2", defaultConfig())

	// StartSession emits: engine_status(starting) + engine_working_message("") + engine_status(idle)
	if firstCount != 3 {
		t.Errorf("first callback expected 3 calls, got %d", firstCount)
	}
	if secondCount != 3 {
		t.Errorf("second callback expected 3 calls, got %d", secondCount)
	}
}

// ---------------------------------------------------------------------------
// translateToEngineEvent tests
// ---------------------------------------------------------------------------

func TestTranslateToEngineEvent_AllTypes(t *testing.T) {
	tests := []struct {
		name     string
		input    types.NormalizedEvent
		wantType string
	}{
		{
			name:     "text_chunk",
			input:    types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "hi"}},
			wantType: "engine_text_delta",
		},
		{
			name:     "tool_call",
			input:    types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1"}},
			wantType: "engine_tool_start",
		},
		{
			name:     "tool_result",
			input:    types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", Content: "ok"}},
			wantType: "engine_tool_end",
		},
		{
			name:     "task_complete",
			input:    types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", CostUsd: 0.1}},
			wantType: "engine_status",
		},
		{
			name:     "error",
			input:    types.NormalizedEvent{Data: &types.ErrorEvent{ErrorMessage: "boom"}},
			wantType: "engine_error",
		},
		{
			name: "usage",
			input: types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{
				InputTokens: intPtr(100), OutputTokens: intPtr(50),
			}}},
			wantType: "engine_message_end",
		},
		{
			name: "session_dead",
			input: types.NormalizedEvent{Data: &types.SessionDeadEvent{
				ExitCode: intPtr(1),
			}},
			wantType: "engine_dead",
		},
		{
			name:     "nil_data",
			input:    types.NormalizedEvent{Data: nil},
			wantType: "engine_error",
		},
		{
			name:     "tool_call_update",
			input:    types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{ToolID: "t1", PartialInput: `{"file`}},
			wantType: "engine_tool_update",
		},
		{
			name:     "tool_call_complete",
			input:    types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{Index: 2}},
			wantType: "engine_tool_complete",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := translateToEngineEvent(tt.input, 200000)
			if result.Type != tt.wantType {
				t.Errorf("expected type %q, got %q", tt.wantType, result.Type)
			}
		})
	}
}

func TestTranslateToEngineEvent_TaskCompleteSessionID(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{SessionID: "abc-123", CostUsd: 0.05},
	}, 200000)
	if result.Type != "engine_status" {
		t.Fatalf("expected engine_status, got %q", result.Type)
	}
	if result.Fields == nil || result.Fields.SessionID != "abc-123" {
		t.Errorf("expected SessionID 'abc-123' in Fields, got %q", result.Fields.SessionID)
	}
}

func TestTranslateToEngineEvent_UnknownType(t *testing.T) {
	// SessionInitEvent is a valid NormalizedEventData but not handled
	// by the translateToEngineEvent switch (falls through to default).
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.SessionInitEvent{SessionID: "test"},
	}, 200000)
	if result.Type != "" {
		t.Errorf("expected empty type for unknown events (silent drop), got %q", result.Type)
	}
}

func TestTranslateToEngineEvent_ToolCallUpdate(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.ToolCallUpdateEvent{ToolID: "tool-42", PartialInput: `{"file_path":"/tmp`},
	}, 200000)
	if result.Type != "engine_tool_update" {
		t.Fatalf("expected engine_tool_update, got %q", result.Type)
	}
	if result.ToolID != "tool-42" {
		t.Errorf("expected ToolID 'tool-42', got %q", result.ToolID)
	}
	if result.ToolPartialInput != `{"file_path":"/tmp` {
		t.Errorf("expected PartialInput, got %q", result.ToolPartialInput)
	}
}

func TestTranslateToEngineEvent_ToolCallComplete(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.ToolCallCompleteEvent{Index: 3},
	}, 200000)
	if result.Type != "engine_tool_complete" {
		t.Fatalf("expected engine_tool_complete, got %q", result.Type)
	}
	if result.ToolIndex == nil || *result.ToolIndex != 3 {
		t.Errorf("expected ToolIndex 3, got %v", result.ToolIndex)
	}
}

func TestTranslateToEngineEvent_ToolCallCompleteZeroIndex(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.ToolCallCompleteEvent{Index: 0},
	}, 200000)
	if result.Type != "engine_tool_complete" {
		t.Fatalf("expected engine_tool_complete, got %q", result.Type)
	}
	if result.ToolIndex == nil || *result.ToolIndex != 0 {
		t.Errorf("expected ToolIndex 0 (not nil), got %v", result.ToolIndex)
	}
}

func TestTranslateToEngineEvent_UsageContextPercent(t *testing.T) {
	in := 150000
	out := 50000
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{
			InputTokens: &in, OutputTokens: &out,
		}},
	}, 200000)
	if result.EndUsage == nil {
		t.Fatal("expected EndUsage")
	}
	// 150000 * 100 / 200000 = 75
	if result.EndUsage.ContextPercent != 75 {
		t.Errorf("expected contextPercent=75, got %d", result.EndUsage.ContextPercent)
	}
}

func TestTranslateToEngineEvent_UsageNilTokens(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{}},
	}, 200000)
	if result.EndUsage == nil {
		t.Fatal("expected EndUsage")
	}
	if result.EndUsage.ContextPercent != 0 {
		t.Errorf("expected contextPercent=0 with nil tokens, got %d", result.EndUsage.ContextPercent)
	}
	if result.EndUsage.InputTokens != 0 {
		t.Errorf("expected inputTokens=0, got %d", result.EndUsage.InputTokens)
	}
}

// ---------------------------------------------------------------------------
// isDescendant tests
// ---------------------------------------------------------------------------

func TestIsDescendant_DirectChild(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"parent": {PID: 1},
		"child":  {PID: 2, ParentAgent: "parent"},
	}
	if !isDescendant(reg, "child", "parent") {
		t.Error("child should be descendant of parent")
	}
}

func TestIsDescendant_GrandChild(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"root":       {PID: 1},
		"child":      {PID: 2, ParentAgent: "root"},
		"grandchild": {PID: 3, ParentAgent: "child"},
	}
	if !isDescendant(reg, "grandchild", "root") {
		t.Error("grandchild should be descendant of root")
	}
}

func TestIsDescendant_NotRelated(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1},
		"b": {PID: 2},
	}
	if isDescendant(reg, "b", "a") {
		t.Error("b should not be descendant of a")
	}
}

func TestIsDescendant_CycleProtection(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1, ParentAgent: "b"},
		"b": {PID: 2, ParentAgent: "a"},
	}
	// Should not loop forever
	result := isDescendant(reg, "a", "c")
	if result {
		t.Error("should not be descendant when ancestor not in cycle")
	}
}

func TestIsDescendant_SelfNotDescendant(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1},
	}
	if isDescendant(reg, "a", "a") {
		t.Error("a should not be descendant of itself")
	}
}

func TestIsDescendant_DeepChain(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"n0": {PID: 1},
		"n1": {PID: 2, ParentAgent: "n0"},
		"n2": {PID: 3, ParentAgent: "n1"},
		"n3": {PID: 4, ParentAgent: "n2"},
		"n4": {PID: 5, ParentAgent: "n3"},
		"n5": {PID: 6, ParentAgent: "n4"},
	}
	if !isDescendant(reg, "n5", "n0") {
		t.Error("n5 should be descendant of n0")
	}
	if isDescendant(reg, "n0", "n5") {
		t.Error("n0 should not be descendant of n5")
	}
}
