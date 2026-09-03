package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

// abortMarkerEnv starts a session backed by a real conversation file so the
// run-exit write has somewhere to land, and returns the manager, the mock
// backend, and the conversation id.
func abortMarkerEnv(t *testing.T, key, convID string) (*Manager, *mockBackend) {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)
	if err := os.MkdirAll(filepath.Join(dataDir, "conversations"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	conv := conversation.CreateConversation(convID, "sys", "test-model")
	conversation.AddUserMessage(conv, "start a long job")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession(key, defaultConfig())
	mgr.sessions[key].conversationID = convID
	_ = mgr.SendPrompt(key, "start", nil)
	return mgr, mb
}

func abortEntries(t *testing.T, convID string) []conversation.AbortedData {
	t.Helper()
	loaded, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var out []conversation.AbortedData
	for _, entry := range loaded.Entries {
		if entry.Type != conversation.EntryAborted {
			continue
		}
		data, ok := entry.Data.(map[string]any)
		if !ok {
			t.Fatalf("aborted entry data = %T, want the persisted map", entry.Data)
		}
		out = append(out, conversation.AbortedData{
			RunID:  data["runId"].(string),
			Source: data["source"].(string),
			Scope:  stringField(data, "scope"),
			Signal: stringField(data, "signal"),
		})
	}
	return out
}

func stringField(data map[string]any, key string) string {
	v, ok := data[key].(string)
	if !ok {
		return ""
	}
	return v
}

// TestAbortMarker_OperatorStopIsPersistedOnce is the regression bar for the
// course-correction count. The operator pressing Stop is their primary redirect
// verb, and before this marker it left no trace on disk at all: a cancelled run
// and a completed run were the same file.
//
// Revert the persistAbortMarker call in handleRunExit and this goes red — the
// entry count is zero, and anything counting operator redirects reads zero
// forever.
func TestAbortMarker_OperatorStopIsPersistedOnce(t *testing.T) {
	const key, convID = "abort-marker-op", "abort-marker-conv-1"
	mgr, mb := abortMarkerEnv(t, key, convID)

	runID := mb.startedInOrder()[0]
	mgr.SendAbortScoped(key, AbortScopeOrchestrator)
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")
	// A run exit can be delivered twice; one stop must stay one stop.
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	got := abortEntries(t, convID)
	if len(got) != 1 {
		t.Fatalf("aborted entries = %d, want 1: %+v", len(got), got)
	}
	if got[0].Source != conversation.AbortSourceUser {
		t.Errorf("source = %q, want %q — an operator stop must not read as an engine cancel", got[0].Source, conversation.AbortSourceUser)
	}
	if got[0].Scope != string(AbortScopeOrchestrator) {
		t.Errorf("scope = %q, want %q", got[0].Scope, AbortScopeOrchestrator)
	}
	if got[0].RunID != runID {
		t.Errorf("run id = %q, want %q", got[0].RunID, runID)
	}
}

// TestAbortMarker_EngineCancelIsNotAnOperatorStop pins the distinction the
// Source field exists for. A cancel that came from inside the run — a turn or
// tool hook, a watchdog — is still recorded, because the run really did stop,
// but it is not the operator redirecting and must never be counted as one.
func TestAbortMarker_EngineCancelIsNotAnOperatorStop(t *testing.T) {
	const key, convID = "abort-marker-engine", "abort-marker-conv-2"
	_, mb := abortMarkerEnv(t, key, convID)

	runID := mb.startedInOrder()[0]
	// No abort command at all — the runloop cancelled itself.
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	got := abortEntries(t, convID)
	if len(got) != 1 {
		t.Fatalf("aborted entries = %d, want 1: %+v", len(got), got)
	}
	if got[0].Source != conversation.AbortSourceEngine {
		t.Errorf("source = %q, want %q", got[0].Source, conversation.AbortSourceEngine)
	}
	if got[0].Scope != "" {
		t.Errorf("scope = %q, want empty — an engine cancel has no abort scope", got[0].Scope)
	}
}

// TestAbortMarker_NormalCompletionWritesNothing keeps the marker honest. A run
// that finished is not an abort, and recording one would inflate every count
// built on this entry.
func TestAbortMarker_NormalCompletionWritesNothing(t *testing.T) {
	const key, convID = "abort-marker-clean", "abort-marker-conv-3"
	_, mb := abortMarkerEnv(t, key, convID)

	runID := mb.startedInOrder()[0]
	mb.emitExit(runID, intPtr(0), nil, "")

	if got := abortEntries(t, convID); len(got) != 0 {
		t.Fatalf("aborted entries = %d, want 0: %+v", len(got), got)
	}
}

// TestAbortMarker_ForcedKillAfterOperatorStopStaysOperator pins that the
// operator's stop is recorded by who asked for it, not by how the run died. A
// stop that escalates to a hard kill exits abnormally, and reading that as an
// engine-side cancel would lose the operator's redirect at exactly the moment
// it mattered most.
func TestAbortMarker_ForcedKillAfterOperatorStopStaysOperator(t *testing.T) {
	const key, convID = "abort-marker-forced", "abort-marker-conv-4"
	mgr, mb := abortMarkerEnv(t, key, convID)

	runID := mb.startedInOrder()[0]
	mgr.SendAbortScoped(key, AbortScopeAll)
	mb.emitExit(runID, intPtr(137), strPtr("cancelled-forced"), "")

	got := abortEntries(t, convID)
	if len(got) != 1 {
		t.Fatalf("aborted entries = %d, want 1: %+v", len(got), got)
	}
	if got[0].Source != conversation.AbortSourceUser {
		t.Errorf("source = %q, want %q", got[0].Source, conversation.AbortSourceUser)
	}
	if got[0].Signal != "cancelled-forced" {
		t.Errorf("signal = %q, want %q", got[0].Signal, "cancelled-forced")
	}
}
