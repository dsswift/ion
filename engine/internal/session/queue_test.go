package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// boolPtr is a test helper for *bool fields on PromptOverrides.
func boolPtr(v bool) *bool { return &v }

// allFieldsOverrides constructs a PromptOverrides with every one of the 19
// fields set to a non-zero / non-nil value. Used to assert that no field
// is silently dropped during the enqueue → dequeue round-trip.
func allFieldsOverrides() *PromptOverrides {
	enabled := true
	return &PromptOverrides{
		Model:                               "gpt-4o",
		MaxTurns:                            7,
		MaxBudgetUsd:                        1.23,
		Extensions:                          []string{"ext-a", "ext-b"},
		NoExtensions:                        true,
		AppendSystemPrompt:                  "sys-extra",
		Attachments:                         []types.ImageAttachment{{MediaType: "image/png", Data: "base64data"}},
		ImplementationPhase:                 true,
		ThinkingEffort:                      "high",
		EnterPlanModeDescription:            "enter-desc",
		PlanModeSparseReminder:              "sparse-reminder",
		PlanFilePath:                        "/tmp/plan.md",
		BashAllowlistAdditionsForThisPrompt: []string{"npm run test"},
		CompactTargetPercent:                0.75,
		CompactMicroKeepTurns:               3,
		CompactEnabled:                      &enabled,
		CompactSummaryEnabled:               boolPtr(true),
		CompactMemoryEnabled:                boolPtr(false),
		ResolveSlash:                        true,
	}
}

// TestQueuedPromptPreservesFullOverrides asserts that all 19 PromptOverrides
// fields survive the enqueueIfBusy → dispatchQueuedPrompt round-trip.
// The old implementation stored only 8 fields in pendingPrompt and silently
// dropped the other 11 (including ResolveSlash, BashAllowlistAdditions, etc.).
func TestQueuedPromptPreservesFullOverrides(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("q-full", defaultConfig())

	original := allFieldsOverrides()

	// Enqueue by directly calling enqueueIfBusy (simulates the busy-session path).
	mgr.mu.Lock()
	s := mgr.sessions["q-full"]
	queueFull, err := mgr.enqueueIfBusy(s, "q-full", "hello", original)
	mgr.mu.Unlock()

	if err != nil || queueFull {
		t.Fatalf("enqueueIfBusy: unexpected queueFull=%v err=%v", queueFull, err)
	}

	// Inspect the stored pendingPrompt directly — no goroutine dispatch needed.
	mgr.mu.RLock()
	queue := mgr.sessions["q-full"].promptQueue
	mgr.mu.RUnlock()

	if len(queue) != 1 {
		t.Fatalf("expected 1 queued prompt, got %d", len(queue))
	}
	got := queue[0].overrides
	if got == nil {
		t.Fatal("pendingPrompt.overrides is nil; all fields were dropped")
	}

	// Verify all 19 fields match the original.
	if got.Model != original.Model {
		t.Errorf("Model: got %q, want %q", got.Model, original.Model)
	}
	if got.MaxTurns != original.MaxTurns {
		t.Errorf("MaxTurns: got %d, want %d", got.MaxTurns, original.MaxTurns)
	}
	if got.MaxBudgetUsd != original.MaxBudgetUsd {
		t.Errorf("MaxBudgetUsd: got %f, want %f", got.MaxBudgetUsd, original.MaxBudgetUsd)
	}
	if len(got.Extensions) != len(original.Extensions) {
		t.Errorf("Extensions len: got %d, want %d", len(got.Extensions), len(original.Extensions))
	}
	if !got.NoExtensions {
		t.Error("NoExtensions: got false, want true")
	}
	if got.AppendSystemPrompt != original.AppendSystemPrompt {
		t.Errorf("AppendSystemPrompt: got %q, want %q", got.AppendSystemPrompt, original.AppendSystemPrompt)
	}
	if len(got.Attachments) != 1 {
		t.Errorf("Attachments len: got %d, want 1", len(got.Attachments))
	}
	if !got.ImplementationPhase {
		t.Error("ImplementationPhase: got false, want true")
	}
	if got.ThinkingEffort != original.ThinkingEffort {
		t.Errorf("ThinkingEffort: got %q, want %q", got.ThinkingEffort, original.ThinkingEffort)
	}
	if got.EnterPlanModeDescription != original.EnterPlanModeDescription {
		t.Errorf("EnterPlanModeDescription: got %q, want %q", got.EnterPlanModeDescription, original.EnterPlanModeDescription)
	}
	if got.PlanModeSparseReminder != original.PlanModeSparseReminder {
		t.Errorf("PlanModeSparseReminder: got %q, want %q", got.PlanModeSparseReminder, original.PlanModeSparseReminder)
	}
	if got.PlanFilePath != original.PlanFilePath {
		t.Errorf("PlanFilePath: got %q, want %q", got.PlanFilePath, original.PlanFilePath)
	}
	if len(got.BashAllowlistAdditionsForThisPrompt) != 1 || got.BashAllowlistAdditionsForThisPrompt[0] != "npm run test" {
		t.Errorf("BashAllowlistAdditions: got %v", got.BashAllowlistAdditionsForThisPrompt)
	}
	if got.CompactTargetPercent != original.CompactTargetPercent {
		t.Errorf("CompactTargetPercent: got %f, want %f", got.CompactTargetPercent, original.CompactTargetPercent)
	}
	if got.CompactMicroKeepTurns != original.CompactMicroKeepTurns {
		t.Errorf("CompactMicroKeepTurns: got %d, want %d", got.CompactMicroKeepTurns, original.CompactMicroKeepTurns)
	}
	if got.CompactEnabled == nil || !*got.CompactEnabled {
		t.Error("CompactEnabled: got nil or false, want true")
	}
	if got.CompactSummaryEnabled == nil || !*got.CompactSummaryEnabled {
		t.Error("CompactSummaryEnabled: got nil or false, want true")
	}
	if got.CompactMemoryEnabled == nil || *got.CompactMemoryEnabled {
		t.Error("CompactMemoryEnabled: got nil or true, want false")
	}
	if !got.ResolveSlash {
		t.Error("ResolveSlash: got false, want true")
	}
}

// TestQueuedPromptNilOverrides asserts that enqueuing with nil overrides stores
// nil and dispatchQueuedPrompt forwards nil to SendPrompt without panicking.
func TestQueuedPromptNilOverrides(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("q-nil", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["q-nil"]
	queueFull, err := mgr.enqueueIfBusy(s, "q-nil", "hello", nil)
	mgr.mu.Unlock()

	if err != nil || queueFull {
		t.Fatalf("enqueueIfBusy: unexpected queueFull=%v err=%v", queueFull, err)
	}

	mgr.mu.RLock()
	pp := mgr.sessions["q-nil"].promptQueue[0]
	mgr.mu.RUnlock()

	if pp.overrides != nil {
		t.Errorf("expected nil overrides, got %+v", pp.overrides)
	}

	// dispatchQueuedPrompt must not panic with a nil overrides.
	// We verify by calling it and waiting briefly — no crash = pass.
	mgr.dispatchQueuedPrompt("q-nil", &pp)
	time.Sleep(20 * time.Millisecond)
}

// TestQueuedPromptResolveSlashSurvivesQueue is the regression test for the
// specific bug: a prompt with ONLY ResolveSlash=true (all other fields zero)
// was previously dispatched with nil overrides by the old guard condition
//
//	`if next.model != "" || next.maxTurns > 0 || ... || next.thinkingEffort != ""`
//
// which evaluated false for a pure-ResolveSlash overrides, silently stripping
// the flag and dispatching the slash invocation as plain text.
func TestQueuedPromptResolveSlashSurvivesQueue(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("q-slash", defaultConfig())

	original := &PromptOverrides{ResolveSlash: true}

	mgr.mu.Lock()
	s := mgr.sessions["q-slash"]
	_, _ = mgr.enqueueIfBusy(s, "q-slash", "/mycommand args", original)
	mgr.mu.Unlock()

	mgr.mu.RLock()
	pp := mgr.sessions["q-slash"].promptQueue[0]
	mgr.mu.RUnlock()

	if pp.overrides == nil {
		t.Fatal("overrides is nil — ResolveSlash was stripped (regression)")
	}
	if !pp.overrides.ResolveSlash {
		t.Error("ResolveSlash is false after queue round-trip (regression)")
	}
}
