package session

// start_session_test.go — tests for StartSession context-% seeding (B1) and
// the truthful initial idle engine_status (B2). A resumed conversation with a
// non-zero Usage on an assistant message must report a non-zero contextPercent
// in its first idle status, and lastContextPct must survive a run exit.

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// seedResumableConversation writes a conversation with an assistant message
// carrying Usage under a temp HOME so StartSession resumes it. Returns the
// conversation ID. contextWindow defaults to conversation.DefaultContext for
// models with no registered info, so lastInputTokens is chosen to yield a
// predictable non-zero percentage against that denominator.
func seedResumableConversation(t *testing.T, id string, lastInputTokens int) {
	t.Helper()
	conv := conversation.CreateConversation(id, "you are a bot", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "hello there")
	// Add an assistant message with Usage so GetContextUsage uses the API path
	// after rehydration on load.
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hello"}}, types.LlmUsage{InputTokens: lastInputTokens, OutputTokens: 10})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
}

// TestStartSession_SeedsContextPctFromConversation proves a resumed
// conversation with a non-zero LastInputTokens emits a non-zero contextPercent
// in its initial idle engine_status (rather than the old hardcoded 0%).
func TestStartSession_SeedsContextPctFromConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	const convID = "1781483744990-seedpcttest"
	// 20000 tokens against the 200000 default window ≈ 10%.
	seedResumableConversation(t, convID, 20000)

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	cfg := defaultConfig()
	cfg.SessionID = convID
	if _, err := mgr.StartSession("seed-pct", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	last, ok := cap.last("seed-pct")
	if !ok {
		t.Fatalf("no engine_status emitted for seed-pct")
	}
	if last.Fields == nil {
		t.Fatalf("idle status has nil Fields")
	}
	if last.Fields.State != "idle" {
		t.Fatalf("expected final state=idle, got %q", last.Fields.State)
	}
	if last.Fields.ContextPercent <= 0 {
		t.Fatalf("expected non-zero contextPercent seeded from conversation, got %d", last.Fields.ContextPercent)
	}
	if last.Fields.SessionID != convID {
		t.Fatalf("idle status SessionID = %q, want %q", last.Fields.SessionID, convID)
	}
	if last.Fields.ContextWindow <= 0 {
		t.Fatalf("expected non-zero contextWindow, got %d", last.Fields.ContextWindow)
	}
}

// TestStartSession_IdleStatusRetainsPctAfterRunExit proves that handleRunExit
// does not reset lastContextPct — a resumed session's seeded (or run-accrued)
// context percentage survives run exit so idle emissions stay truthful.
func TestStartSession_IdleStatusRetainsPctAfterRunExit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	const convID = "1781483744990-retainpct0"
	seedResumableConversation(t, convID, 20000)

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	cfg := defaultConfig()
	cfg.SessionID = convID
	if _, err := mgr.StartSession("retain-pct", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.RLock()
	s := mgr.sessions["retain-pct"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatalf("session not registered")
	}
	mgr.mu.RLock()
	seeded := s.lastContextPct
	mgr.mu.RUnlock()
	if seeded <= 0 {
		t.Fatalf("precondition: expected seeded lastContextPct > 0, got %d", seeded)
	}

	// Bind a run to the session so handleRunExit resolves the key, then exit it.
	mgr.mu.Lock()
	s.requestID = "run-retain-1"
	mgr.bindRunLocked("run-retain-1", "retain-pct")
	mgr.mu.Unlock()

	code := 0
	mgr.handleRunExit("run-retain-1", &code, nil, convID)

	mgr.mu.RLock()
	after := s.lastContextPct
	mgr.mu.RUnlock()
	if after != seeded {
		t.Fatalf("lastContextPct changed across run exit: before=%d after=%d (must be retained)", seeded, after)
	}

	// A subsequent idle snapshot must still carry the retained percentage.
	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())
	mgr.emitStatusSnapshot("retain-pct", "test")
	last, ok := cap.last("retain-pct")
	if !ok || last.Fields == nil {
		t.Fatalf("no idle status emitted after run exit")
	}
	if last.Fields.ContextPercent != seeded {
		t.Fatalf("idle status pct = %d, want retained %d", last.Fields.ContextPercent, seeded)
	}
}
