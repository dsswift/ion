package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestBuildStatusFields_PreservesRunningStateOnCountUpdate(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-running"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.requestID = "live-run"
	s.dispatchingRunID = "live-run"
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.State != "running" {
		t.Fatalf("State = %q, want running", fields.State)
	}
}

func TestBuildStatusFields_PendingWorkIsNotTerminal(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-pending"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.promptQueue = append(s.promptQueue, pendingPrompt{text: "accepted follow-up"})
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.State != "idle" {
		t.Fatalf("State = %q, want idle foreground", fields.State)
	}
	if !fields.HasPendingWork {
		t.Fatal("HasPendingWork = false, want true for accepted prompt")
	}

	mirror := buildSessionStatusMirror(key, fields, s)
	if mirror.SessionStatus == nil || !mirror.SessionStatus.HasPendingWork {
		t.Fatal("engine_session_status did not preserve HasPendingWork")
	}
	status := types.StatusFields{HasPendingWork: fields.HasPendingWork}
	if !status.HasPendingWork {
		t.Fatal("status fields lost pending-work contract")
	}
}

func TestBuildStatusFields_PreservesCompletionReasonUntilNextPrompt(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-completion-reason"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	mgr.sessions[key].lastCompletionReason = types.TaskCompletionReasonNormal
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.CompletionReason != types.TaskCompletionReasonNormal {
		t.Fatalf("CompletionReason = %q, want normal", fields.CompletionReason)
	}
}
