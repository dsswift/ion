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

// resumeEventCollector captures events emitted by the session manager.
type resumeEventCollector struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func newResumeEventCollector(mgr *session.Manager) *resumeEventCollector {
	ec := &resumeEventCollector{}
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		ec.mu.Lock()
		ec.events = append(ec.events, event)
		ec.mu.Unlock()
	})
	return ec
}

func (ec *resumeEventCollector) all() []types.EngineEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]types.EngineEvent, len(ec.events))
	copy(out, ec.events)
	return out
}

func (ec *resumeEventCollector) byType(t string) []types.EngineEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	var out []types.EngineEvent
	for _, e := range ec.events {
		if e.Type == t {
			out = append(out, e)
		}
	}
	return out
}

// ─── Test 1: SessionID from config flows through to RunOptions ───

func TestStartSessionWithSessionID(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	config := defaultConfig()
	config.SessionID = "existing-conv"

	if err := mgr.StartSession("resume-1", config); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-1") })

	if err := mgr.SendPrompt("resume-1", "continue where we left off", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	opts, ok := mb.GetStarted(keys[0])
	if !ok {
		t.Fatal("started run not found")
	}
	if opts.SessionID != "existing-conv" {
		t.Errorf("expected SessionID='existing-conv', got %q", opts.SessionID)
	}
}

// ─── Test 2: SessionID from exit persists to next prompt ───

func TestSessionIDPersistsAcrossPrompts(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	if err := mgr.StartSession("resume-2", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-2") })

	// First prompt.
	if err := mgr.SendPrompt("resume-2", "first message", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}
	firstRunID := keys[0]

	// First run had no sessionID.
	opts1, _ := mb.GetStarted(firstRunID)
	if opts1.SessionID != "" {
		t.Errorf("expected empty SessionID on first run, got %q", opts1.SessionID)
	}

	// Simulate exit with a sessionID returned by the backend.
	mb.EmitExit(firstRunID, nil, nil, "conv-abc")
	time.Sleep(100 * time.Millisecond)

	// Verify we got an idle status (run completed).
	idleEvents := ec.byType("engine_status")
	foundIdle := false
	for _, e := range idleEvents {
		if e.Fields != nil && e.Fields.State == "idle" {
			foundIdle = true
			break
		}
	}
	if !foundIdle {
		t.Fatal("expected engine_status with state=idle after first run exit")
	}

	// Second prompt should carry the sessionID from the first run's exit.
	if err := mgr.SendPrompt("resume-2", "second message", nil); err != nil {
		t.Fatalf("SendPrompt (second): %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys = mb.StartedKeys()
	if len(keys) != 2 {
		t.Fatalf("expected 2 started runs, got %d", len(keys))
	}

	// Find the second run (the one that isn't firstRunID).
	var secondRunID string
	for _, k := range keys {
		if k != firstRunID {
			secondRunID = k
			break
		}
	}
	if secondRunID == "" {
		t.Fatal("could not find second run ID")
	}

	opts2, ok := mb.GetStarted(secondRunID)
	if !ok {
		t.Fatal("second started run not found")
	}
	if opts2.SessionID != "conv-abc" {
		t.Errorf("expected SessionID='conv-abc' on second run, got %q", opts2.SessionID)
	}
}

// ─── Test 3: Normal exit (nil code, nil signal) emits idle but NOT engine_dead ───

func TestEngineDeadCodeZeroNoDeadEvent(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	if err := mgr.StartSession("resume-3", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-3") })

	if err := mgr.SendPrompt("resume-3", "do something", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	// Normal completion: code=nil, signal=nil.
	mb.EmitExit(keys[0], nil, nil, "")
	time.Sleep(100 * time.Millisecond)

	// Should NOT have engine_dead.
	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) != 0 {
		t.Errorf("expected no engine_dead event for normal exit (nil code/signal), got %d", len(deadEvents))
	}

	// Should have engine_status with state=idle.
	statusEvents := ec.byType("engine_status")
	foundIdle := false
	for _, e := range statusEvents {
		if e.Fields != nil && e.Fields.State == "idle" {
			foundIdle = true
			break
		}
	}
	if !foundIdle {
		t.Error("expected engine_status with state=idle after normal exit")
	}
}

// ─── Test 4: Non-zero exit code emits engine_dead ───

func TestEngineDeadNonZeroEmitsDeadEvent(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	if err := mgr.StartSession("resume-4", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-4") })

	if err := mgr.SendPrompt("resume-4", "do something", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	// Non-zero exit.
	exitCode := 1
	mb.EmitExit(keys[0], &exitCode, nil, "")
	time.Sleep(100 * time.Millisecond)

	// Should have engine_dead with exitCode=1.
	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event for non-zero exit code")
	}
	if deadEvents[0].ExitCode == nil {
		t.Fatal("expected engine_dead event to have non-nil ExitCode")
	}
	if *deadEvents[0].ExitCode != 1 {
		t.Errorf("expected exitCode=1, got %d", *deadEvents[0].ExitCode)
	}
}
