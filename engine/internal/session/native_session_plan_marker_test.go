package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestPersistCliTurn_AppendsPlanMarkerFromNativeCapture is the regression pin
// for delegated-CLI plans being invisible to the conversation tree.
//
// A delegated CLI (Claude Code, codex, cursor) captures its plan natively and
// emits PlanFileWrittenEvent, but owns no conversation of its own — the
// session writes the whole turn at run exit. Before this wiring nothing
// appended the plan marker on that path, so LatestUnimplementedPlan found no
// marker, `/clear --keep-plan` reported "no plan to keep", and the history
// renderer showed no plan row — for a plan the user had just approved.
//
// Revert either half of the fix (the PlanFileWrittenEvent recording in
// handleNormalizedEvent, or the append in persistCliTurn) and this test fails
// on the found=false branch.
func TestPersistCliTurn_AppendsPlanMarkerFromNativeCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key = "cli-plan-marker"
	_, _ = mgr.StartSession(key, defaultConfig())

	const convID = "1784000000000-b1b1b1b1b1b1"
	const runID = "cli-plan-marker-run-1"
	const planPath = "/tmp/ion-test-plans/bold-drumming-notebook.md"
	const planSlug = "bold-drumming-notebook"

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.requestID = runID
	s.pendingCliUserTurn = "plan the docs work"
	s.pendingCliAssistantText = "Plan is ready."
	// A delegated-CLI root run is exactly the state that carries a recorder.
	s.cliTranscript = newCliTranscriptRecorder()
	mgr.mu.Unlock()

	// The event the native capture path emits (plan_capture.go) after it
	// writes the plan file.
	mgr.handleNormalizedEvent(runID, types.NormalizedEvent{Data: &types.PlanFileWrittenEvent{
		Operation:    "created",
		PlanFilePath: planPath,
		PlanSlug:     planSlug,
	}})

	mgr.mu.RLock()
	recorded := s.pendingCliPlanMarker
	mgr.mu.RUnlock()
	if recorded == nil {
		t.Fatalf("PlanFileWrittenEvent did not record a pending plan marker on the delegated-CLI session")
	}
	if recorded.PlanFilePath != planPath || recorded.PlanSlug != planSlug || recorded.Operation != "created" {
		t.Fatalf("recorded marker = %+v, want path=%q slug=%q op=created", recorded, planPath, planSlug)
	}

	mgr.persistCliTurn(key, convID)

	// The pending marker is drained so a later exit cannot double-append.
	mgr.mu.RLock()
	leftover := s.pendingCliPlanMarker
	mgr.mu.RUnlock()
	if leftover != nil {
		t.Errorf("pending plan marker not cleared after persist: %+v", leftover)
	}

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	markers := 0
	for i := range conv.Entries {
		if conv.Entries[i].Type == conversation.EntryPlanMarker {
			markers++
		}
	}
	if markers != 1 {
		t.Fatalf("plan markers in tree = %d, want exactly 1", markers)
	}

	// The whole point: the marker is on the context path, so the plan
	// resolves for /clear --keep-plan and every other marker consumer.
	gotPath, gotSlug, found := conversation.LatestUnimplementedPlan(conv)
	if !found {
		t.Fatalf("LatestUnimplementedPlan found no plan after a delegated-CLI plan capture")
	}
	if gotPath != planPath || gotSlug != planSlug {
		t.Errorf("resolved plan = (%q, %q), want (%q, %q)", gotPath, gotSlug, planPath, planSlug)
	}
}

// TestPlanFileWritten_NotRecordedOutsideDelegatedCliRun pins the one-writer
// rule. The engine-owned ApiBackend appends its own marker inline against
// run.conv (runloop_tools.go) and never reaches persistCliTurn. Recording the
// event for it too would set state nothing drains, and would double-append the
// day that path changed. The gate is the active CLI transcript recorder.
func TestPlanFileWritten_NotRecordedOutsideDelegatedCliRun(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	const key = "api-plan-marker"
	_, _ = mgr.StartSession(key, defaultConfig())

	const runID = "api-plan-marker-run-1"
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = "1784000000000-c2c2c2c2c2c2"
	s.requestID = runID
	s.cliTranscript = nil // engine-owned run: no delegated recorder
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent(runID, types.NormalizedEvent{Data: &types.PlanFileWrittenEvent{
		Operation:    "created",
		PlanFilePath: "/tmp/ion-test-plans/api-authored.md",
		PlanSlug:     "api-authored",
	}})

	mgr.mu.RLock()
	recorded := s.pendingCliPlanMarker
	mgr.mu.RUnlock()
	if recorded != nil {
		t.Fatalf("engine-owned run recorded a delegated-CLI plan marker: %+v", recorded)
	}
}
