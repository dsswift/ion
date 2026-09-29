package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
)

// A plan for an engine-owned backend lives in the conversation's own folder,
// so a fork copies it and a transfer moves it with the conversation.
func TestAllocateNewPlanFilePath_ConversationFolder(t *testing.T) {
	caps := backend.BackendCapabilities{Kind: "api"}
	path := allocateNewPlanFilePath(caps, t.TempDir(), "conv-owns-plan")
	want := conversation.PlansDir("conv-owns-plan") + string(filepath.Separator)
	if !strings.HasPrefix(path, want) {
		t.Fatalf("plan path %q, want it under %q", path, want)
	}
	if !conversation.IsOwnedPlanPath(path) {
		t.Fatalf("allocated plan %q is not recognised as an owned plan", path)
	}
}

// The fork's session holds its own copy of the plan. Before forks owned their
// files it held the source's path, so the fork's plan edits changed the
// source's plan.
func TestForkSession_ForkGetsItsOwnPlan(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	config := defaultConfig()
	config.WorkingDirectory = t.TempDir()
	if _, err := mgr.StartSession("fork-own-source", config); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	sourceID := mgr.sessions["fork-own-source"].conversationID
	mgr.mu.Unlock()

	sourcePlan := filepath.Join(conversation.PlansDir(sourceID), "tidy-reading-lamp.md")
	if err := os.MkdirAll(filepath.Dir(sourcePlan), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePlan, []byte("source plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	mgr.SetPlanMode("fork-own-source", true, []string{"Read"}, "test", sourcePlan)
	source := conversation.CreateConversation(sourceID, "system", "test-model")
	conversation.AppendEntry(source, conversation.EntryPlanMarker, conversation.PlanMarkerData{Operation: "created", PlanFilePath: sourcePlan, PlanSlug: "tidy-reading-lamp"})
	conversation.AddUserMessage(source, "first")
	if err := conversation.Save(source, ""); err != nil {
		t.Fatalf("save source: %v", err)
	}

	_, forkID, err := mgr.ForkSessionToKey("fork-own-source", "fork-own-target", 0)
	if err != nil {
		t.Fatalf("ForkSessionToKey: %v", err)
	}
	forkPlan := mgr.SessionPlanFilePath("fork-own-target")
	if forkPlan == sourcePlan || forkPlan != filepath.Join(conversation.PlansDir(forkID), "tidy-reading-lamp.md") {
		t.Fatalf("fork plan = %q (source %q)", forkPlan, sourcePlan)
	}
	if err := os.WriteFile(forkPlan, []byte("fork edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(sourcePlan); string(got) != "source plan" {
		t.Fatalf("source plan changed to %q", got)
	}
	loaded, err := conversation.Load(forkID, "")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ForkOf != sourceID {
		t.Fatalf("fork header ForkOf = %q, want %q", loaded.ForkOf, sourceID)
	}
}
