package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// seedPlanConversation writes a conversation with pre-clear history and a plan
// marker for planPath, plus the plan file itself on disk. When implemented is
// true it also records an implementation-phase user turn after the marker.
// Returns the conversation directory.
func seedPlanConversation(t *testing.T, tempHome, convID, planPath, planSlug, planBody string, implemented bool) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(planPath), 0o755); err != nil {
		t.Fatalf("mkdir plans: %v", err)
	}
	if err := os.WriteFile(planPath, []byte(planBody), 0o644); err != nil {
		t.Fatalf("write plan file: %v", err)
	}

	conv := conversation.CreateConversation(convID, "system prompt", "test-model")
	conversation.AddUserMessage(conv, "let's plan")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "planning"}}, types.LlmUsage{InputTokens: 100})
	conversation.AppendEntry(conv, conversation.EntryPlanMarker, conversation.PlanMarkerData{
		Operation: "created", PlanFilePath: planPath, PlanSlug: planSlug,
	})
	if implemented {
		entry := conversation.AddUserMessage(conv, "implement it")
		conversation.SetImplementationPhase(entry, true)
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "implementing"}}, types.LlmUsage{InputTokens: 120})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	return filepath.Join(tempHome, ".ion", "conversations")
}

// TestClearKeepPlan_RetainsUnimplementedPlan is the end-to-end pin for
// `/clear --keep-plan` retaining a plan: the file-only clear path wipes the
// history AND re-injects the plan markdown as the sole machine-authored user
// turn, and returns the plan's slug.
func TestClearKeepPlan_RetainsUnimplementedPlan(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mgr := NewManager(newMockBackend())
	const convID = "keep-plan-open"
	const planSlug = "brave-baking-otter"
	planPath := filepath.Join(tempHome, ".ion", "plans", planSlug+".md")
	const planBody = "# The Plan\n\n1. do the first thing\n2. do the second thing"
	convDir := seedPlanConversation(t, tempHome, convID, planPath, planSlug, planBody, false)

	keptSlug, err := mgr.ClearConversationFileWithOptions(convID, true)
	if err != nil {
		t.Fatalf("ClearConversationFileWithOptions: %v", err)
	}
	if keptSlug != planSlug {
		t.Fatalf("kept slug = %q, want %q", keptSlug, planSlug)
	}

	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	// The wipe left exactly the injected plan as the LLM-visible context.
	if len(cleared.Messages) != 1 {
		t.Fatalf("post-clear Messages = %d, want 1 (the injected plan): %+v", len(cleared.Messages), cleared.Messages)
	}
	if cleared.Messages[0].Role != "user" {
		t.Errorf("injected message role = %q, want user", cleared.Messages[0].Role)
	}
	body, _ := json.Marshal(cleared.Messages[0].Content)
	if !strings.Contains(string(body), "do the first thing") {
		t.Errorf("injected message does not carry the plan markdown: %s", body)
	}
	if !strings.Contains(string(body), "this plan was kept") {
		t.Errorf("injected message missing the retained-plan preamble: %s", body)
	}

	// The injected turn is classified plan_retained so consumers can identify
	// it and label it. It is NOT machine-to-machine: the operator explicitly
	// chose --keep-plan, so the turn stays visible rather than being hidden
	// like a dispatch callback or a scheduler wake-up.
	var sawPlanRetained bool
	for i := range cleared.Entries {
		md := conversation.AsMessageData(cleared.Entries[i].Data)
		if md != nil && md.InjectionKind == string(types.InjectionKindPlanRetained) {
			sawPlanRetained = true
			if md.MachineAuthored {
				t.Errorf("plan_retained entry marked MachineAuthored, want false (visible, not hidden)")
			}
		}
	}
	if !sawPlanRetained {
		t.Errorf("no entry carried InjectionKind plan_retained")
	}
}

// TestClearKeepPlan_ImplementedPlanNotRetained pins the "clear + notice"
// outcome: when the latest plan's implementation already began, --keep-plan
// retains nothing (empty slug, empty context).
func TestClearKeepPlan_ImplementedPlanNotRetained(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mgr := NewManager(newMockBackend())
	const convID = "keep-plan-done"
	const planSlug = "calm-hiking-finch"
	planPath := filepath.Join(tempHome, ".ion", "plans", planSlug+".md")
	convDir := seedPlanConversation(t, tempHome, convID, planPath, planSlug, "# Done Plan", true)

	keptSlug, err := mgr.ClearConversationFileWithOptions(convID, true)
	if err != nil {
		t.Fatalf("ClearConversationFileWithOptions: %v", err)
	}
	if keptSlug != "" {
		t.Fatalf("kept slug = %q, want empty (implemented plan is not retained)", keptSlug)
	}
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("post-clear Messages = %d, want 0 (nothing retained): %+v", len(cleared.Messages), cleared.Messages)
	}
}

// TestClearKeepPlan_FlagOffLeavesContextEmpty guards that an ordinary clear
// (keepPlan=false) injects nothing even when an unimplemented plan exists — the
// retention only fires on the explicit flag.
func TestClearKeepPlan_FlagOffLeavesContextEmpty(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mgr := NewManager(newMockBackend())
	const convID = "keep-plan-flag-off"
	const planSlug = "tidy-sailing-wren"
	planPath := filepath.Join(tempHome, ".ion", "plans", planSlug+".md")
	convDir := seedPlanConversation(t, tempHome, convID, planPath, planSlug, "# Ignored Plan", false)

	keptSlug, err := mgr.ClearConversationFileWithOptions(convID, false)
	if err != nil {
		t.Fatalf("ClearConversationFileWithOptions: %v", err)
	}
	if keptSlug != "" {
		t.Fatalf("kept slug = %q, want empty when flag is off", keptSlug)
	}
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("post-clear Messages = %d, want 0 (flag off injects nothing)", len(cleared.Messages))
	}
}

// TestClearKeepPlan_NoPlanMarkerRetainsNothing pins the tree as the only
// authority. A conversation with real history but no plan marker keeps
// nothing, even while a plan file sits on disk: the marker is what records
// that a plan belongs to THIS context path and whether its implementation
// began. Answering from a loose file path instead would re-seed a cleared
// context with a plan the conversation had already moved past.
func TestClearKeepPlan_NoPlanMarkerRetainsNothing(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	const convID = "keep-plan-no-marker"
	planPath := filepath.Join(tempHome, ".ion", "plans", "neat-roving-hawk.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o755); err != nil {
		t.Fatalf("mkdir plans: %v", err)
	}
	if err := os.WriteFile(planPath, []byte("# Loose Plan\n\n1. step one"), 0o644); err != nil {
		t.Fatalf("write plan file: %v", err)
	}

	conv := conversation.CreateConversation(convID, "system prompt", "test-model")
	conversation.AddUserMessage(conv, "how does the plan look?")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "plan looks solid"}}, types.LlmUsage{InputTokens: 80})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	convDir := filepath.Join(tempHome, ".ion", "conversations")

	mgr := NewManager(newMockBackend())
	keptSlug, err := mgr.ClearConversationFileWithOptions(convID, true)
	if err != nil {
		t.Fatalf("ClearConversationFileWithOptions: %v", err)
	}
	if keptSlug != "" {
		t.Fatalf("kept slug = %q, want empty (no plan marker on the path)", keptSlug)
	}
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("post-clear Messages = %d, want 0 (nothing retained): %+v", len(cleared.Messages), cleared.Messages)
	}
}

// TestClearArgsRequestKeepPlan pins the flag parser shared by both the
// live-session path (dispatchClear) and server.dispatchCommand's file-only
// clear_conversation_file case.
func TestClearArgsRequestKeepPlan(t *testing.T) {
	cases := map[string]bool{
		"":                    false,
		"--keep-plan":         true,
		"  --keep-plan  ":     true,
		"--keep-plan --other": true,
		"--keepplan":          false,
		"keep-plan":           false,
		"--keep-plan-extra":   false,
	}
	for args, want := range cases {
		if got := ClearArgsRequestKeepPlan(args); got != want {
			t.Errorf("ClearArgsRequestKeepPlan(%q) = %v, want %v", args, got, want)
		}
	}
}
