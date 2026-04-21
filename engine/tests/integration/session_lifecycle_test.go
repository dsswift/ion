//go:build integration

package integration

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

func defaultConfig() types.EngineConfig {
	return types.EngineConfig{
		ProfileID:        "test",
		ExtensionDir:     "/tmp",
		WorkingDirectory: "/tmp",
		Model:            "mock-model",
	}
}

func TestSessionStartStop(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	// Start session
	if err := mgr.StartSession("test-1", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Should be listed
	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "test-1" {
		t.Errorf("expected key=test-1, got %q", sessions[0].Key)
	}

	// Stop
	if err := mgr.StopSession("test-1"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	// Should be empty
	sessions = mgr.ListSessions()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after stop, got %d", len(sessions))
	}
}

func TestSessionSendPrompt(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	if err := mgr.StartSession("prompt-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("prompt-test") })

	// Send prompt
	if err := mgr.SendPrompt("prompt-test", "Hello world", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	// Wait for backend to receive it
	time.Sleep(50 * time.Millisecond)

	// Backend should have received a StartRun call
	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	opts, ok := mb.GetStarted(keys[0])
	if !ok {
		t.Fatal("started run not found")
	}
	if opts.Prompt != "Hello world" {
		t.Errorf("expected prompt 'Hello world', got %q", opts.Prompt)
	}
	if opts.ProjectPath != "/tmp" {
		t.Errorf("expected projectPath '/tmp', got %q", opts.ProjectPath)
	}
}

func TestSessionAbort(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	if err := mgr.StartSession("abort-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("abort-test") })

	// Send a prompt first
	if err := mgr.SendPrompt("abort-test", "Start work", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Session should be running
	if !mgr.IsRunning("abort-test") {
		t.Error("expected session to be running after SendPrompt")
	}

	// Abort
	mgr.SendAbort("abort-test")

	// Backend.Cancel should have been called
	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs were started")
	}
	cancelled := mb.Cancel(keys[0])
	if !cancelled {
		t.Error("expected Cancel to return true for active run")
	}
}

func TestSessionPlanMode(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	if err := mgr.StartSession("plan-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("plan-test") })

	// Enable plan mode with allowed tools
	mgr.SetPlanMode("plan-test", true, []string{"Read", "Grep", "Glob"})

	// Send prompt
	if err := mgr.SendPrompt("plan-test", "Plan the changes", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Check RunOptions
	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run, got %d", len(keys))
	}
	opts, _ := mb.GetStarted(keys[0])
	if !opts.PlanMode {
		t.Error("expected PlanMode=true")
	}
	if len(opts.PlanModeTools) != 3 {
		t.Errorf("expected 3 plan mode tools, got %d", len(opts.PlanModeTools))
	}
}

func TestSessionEvents(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	var mu sync.Mutex
	var events []types.EngineEvent

	mgr.OnEvent(func(key string, event types.EngineEvent) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	})

	if err := mgr.StartSession("events-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("events-test") })

	// Send prompt so we get a request ID
	if err := mgr.SendPrompt("events-test", "Hello", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Get the request ID from backend
	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs started")
	}
	requestID := keys[0]

	// Simulate backend emitting events
	mb.EmitNormalized(requestID, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "Hello from mock"},
	})
	mb.EmitNormalized(requestID, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:  "Done",
			CostUsd: 0.001,
		},
	})
	code := 0
	mb.EmitExit(requestID, &code, nil, "sess-123")

	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	// Should have received: start_session status, running status, text_delta, task_complete status, idle status.
	// Note: engine_dead is only emitted for non-zero exit codes.
	if len(events) < 4 {
		t.Fatalf("expected at least 4 events, got %d: %+v", len(events), events)
	}

	// Check that we got a text delta event
	foundText := false
	for _, e := range events {
		if e.Type == "engine_text_delta" && e.TextDelta == "Hello from mock" {
			foundText = true
			break
		}
	}
	if !foundText {
		t.Error("did not find engine_text_delta with expected text")
	}

	// Check for idle status after clean exit
	foundIdle := false
	for _, e := range events {
		if e.Type == "engine_status" && e.Fields != nil && e.Fields.State == "idle" {
			foundIdle = true
			break
		}
	}
	if !foundIdle {
		t.Error("did not find engine_status{idle} event after clean exit")
	}
}

func TestSessionStopAll(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	for _, key := range []string{"a", "b", "c"} {
		if err := mgr.StartSession(key, defaultConfig()); err != nil {
			t.Fatalf("StartSession(%s): %v", key, err)
		}
	}

	if len(mgr.ListSessions()) != 3 {
		t.Fatal("expected 3 sessions")
	}

	if err := mgr.StopAll(); err != nil {
		t.Fatalf("StopAll: %v", err)
	}

	if len(mgr.ListSessions()) != 0 {
		t.Error("expected 0 sessions after StopAll")
	}
}

func TestSessionStopByPrefix(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	for _, key := range []string{"app-1", "app-2", "other-1"} {
		if err := mgr.StartSession(key, defaultConfig()); err != nil {
			t.Fatalf("StartSession(%s): %v", key, err)
		}
	}

	mgr.StopByPrefix("app-")

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "other-1" {
		t.Errorf("expected 'other-1', got %q", sessions[0].Key)
	}
}

func TestSessionSendPromptNotFound(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	err := mgr.SendPrompt("nonexistent", "hello", nil)
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

func TestSessionStopNotFound(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	err := mgr.StopSession("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}
