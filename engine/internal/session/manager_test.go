package session

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// StartSession tests
// ---------------------------------------------------------------------------

func TestStartSession_CreatesSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, err := mgr.StartSession("s1", defaultConfig())
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "s1" {
		t.Errorf("expected key=s1, got %q", sessions[0].Key)
	}
	if sessions[0].HasActiveRun {
		t.Error("new session should not have active run")
	}
}

func TestStartSession_DuplicateKeyIsIdempotent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	if _, err := mgr.StartSession("dup", defaultConfig()); err != nil {
		t.Fatalf("first StartSession: %v", err)
	}

	result, err := mgr.StartSession("dup", defaultConfig())
	if err != nil {
		t.Fatalf("duplicate StartSession should not error, got: %v", err)
	}
	if !result.Existed {
		t.Error("expected Existed=true for duplicate key")
	}
}

func TestStartSession_EmitsStatusEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("s1", defaultConfig())

	statuses := ec.byType("engine_status")
	// StartSession emits: engine_status(starting) then engine_status(idle)
	if len(statuses) != 2 {
		t.Fatalf("expected 2 status events, got %d", len(statuses))
	}
	if statuses[0].event.Fields.State != "starting" {
		t.Errorf("expected first state=starting, got %q", statuses[0].event.Fields.State)
	}
	if statuses[1].event.Fields == nil {
		t.Fatal("expected status fields on final event")
	}
	if statuses[1].event.Fields.State != "idle" {
		t.Errorf("expected final state=idle, got %q", statuses[1].event.Fields.State)
	}
	if statuses[1].event.Fields.Label != "s1" {
		t.Errorf("expected label=s1, got %q", statuses[1].event.Fields.Label)
	}
	// Model is no longer set at profile/config level -- resolved at runtime
}

func TestStartSession_MultipleSessions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for i := 0; i < 5; i++ {
		key := fmt.Sprintf("session-%d", i)
		if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
			t.Fatalf("StartSession(%s): %v", key, err)
		}
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 5 {
		t.Fatalf("expected 5 sessions, got %d", len(sessions))
	}
}

// ---------------------------------------------------------------------------
// SendPrompt tests
// ---------------------------------------------------------------------------

func TestSendPrompt_ValidSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("p1", defaultConfig())

	err := mgr.SendPrompt("p1", "Hello world", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	opts, _ := mb.getStarted(keys[0])
	if opts.Prompt != "Hello world" {
		t.Errorf("expected prompt 'Hello world', got %q", opts.Prompt)
	}
	if opts.ProjectPath != "/tmp" {
		t.Errorf("expected projectPath '/tmp', got %q", opts.ProjectPath)
	}
	// Model resolved at runtime, not from config
}

func TestSendPrompt_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.SendPrompt("nonexistent", "hello", nil)
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestSendPrompt_QueuesWhenBusy(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("busy", defaultConfig())

	if err := mgr.SendPrompt("busy", "first", nil); err != nil {
		t.Fatalf("first SendPrompt: %v", err)
	}

	// Second prompt should be queued, not rejected
	if err := mgr.SendPrompt("busy", "second", nil); err != nil {
		t.Fatalf("expected second prompt to be queued, got error: %v", err)
	}
}

func TestSendPrompt_QueueFullError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("busy", defaultConfig())

	if err := mgr.SendPrompt("busy", "first", nil); err != nil {
		t.Fatalf("first SendPrompt: %v", err)
	}

	// Fill the queue (default depth 32)
	for i := 0; i < 32; i++ {
		if err := mgr.SendPrompt("busy", fmt.Sprintf("queued-%d", i), nil); err != nil {
			t.Fatalf("queued prompt %d: %v", i, err)
		}
	}

	// 33rd should fail
	err := mgr.SendPrompt("busy", "overflow", nil)
	if err == nil {
		t.Fatal("expected error for full queue")
	}
	if !strings.Contains(err.Error(), "queue full") {
		t.Errorf("expected 'queue full' in error, got %q", err.Error())
	}
}

func TestSendPrompt_EmitsRunningStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("p1", defaultConfig())
	_ = mgr.SendPrompt("p1", "go", nil)

	statuses := ec.byType("engine_status")
	// Should have idle (from start) + running (from prompt)
	if len(statuses) < 2 {
		t.Fatalf("expected at least 2 status events, got %d", len(statuses))
	}
	last := statuses[len(statuses)-1]
	if last.event.Fields.State != "running" {
		t.Errorf("expected state=running, got %q", last.event.Fields.State)
	}
}

func TestSendPrompt_SetsRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("rid", defaultConfig())

	_ = mgr.SendPrompt("rid", "test", nil)

	if !mgr.IsRunning("rid") {
		t.Error("expected session to be running after SendPrompt")
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run, got %d", len(keys))
	}
	if !strings.HasPrefix(keys[0], "rid-") {
		t.Errorf("request ID should start with session key prefix, got %q", keys[0])
	}
}

func TestSendPrompt_PassesMaxTokens(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.MaxTokens = 4096
	_, _ = mgr.StartSession("mt", cfg)

	_ = mgr.SendPrompt("mt", "test", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if opts.MaxTokens != 4096 {
		t.Errorf("expected maxTokens=4096, got %d", opts.MaxTokens)
	}
}

func TestSendPrompt_PassesThinkingConfig(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.Thinking = &types.ThinkingConfig{Enabled: true, BudgetTokens: 8000}
	_, _ = mgr.StartSession("think", cfg)

	_ = mgr.SendPrompt("think", "ponder this", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if opts.Thinking == nil {
		t.Fatal("expected thinking config to be set")
	}
	if !opts.Thinking.Enabled {
		t.Error("expected thinking.enabled=true")
	}
	if opts.Thinking.BudgetTokens != 8000 {
		t.Errorf("expected budgetTokens=8000, got %d", opts.Thinking.BudgetTokens)
	}
}
