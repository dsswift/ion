//go:build integration

package integration

// TestKeepPlanEndToEnd is the live end-to-end pin for /clear --keep-plan.
//
// Three assertions, each exercising a layer the unit tests cannot reach:
//
//  1. Run 1 submits a prompt and receives a text response (history is written to
//     the conversation file by the real ApiBackend).
//
//  2. ClearConversationFileWithOptions(keepPlan=true) wipes that history and
//     re-injects the plan markdown as a single user turn.
//
//  3. Run 2 submits a second prompt.  MockProvider.Calls()[1].Messages is the
//     authoritative LLM context the engine actually sent.  It must have exactly
//     one message before the second prompt — the injected plan — and it must
//     NOT contain any text from the first response.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

func TestKeepPlanEndToEnd(t *testing.T) {
	// Isolate HOME so no live credentials or conversations are touched.
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	// ── Provider setup ────────────────────────────────────────────────────────
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{
		ProviderID:    "mock",
		ContextWindow: 200000,
	})

	// Run 1: the assistant replies with text that must NOT appear in run 2's context.
	const run1Text = "here is my analysis of the problem"
	mp.SetResponse(helpers.TextResponse(run1Text))

	// Run 2: a simple reply so the backend exits cleanly.
	const run2Text = "understood, continuing from the plan"
	mp.SetResponse(helpers.TextResponse(run2Text))

	// ── Conversation file setup ───────────────────────────────────────────────
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conversations: %v", err)
	}
	const convID = "e2e-keep-plan-conv"

	// Write the plan file on disk — the plan retention path reads it.
	const planSlug = "swift-hiking-eagle"
	const planBody = "# Test Plan\n\n1. do the first step\n2. do the second step"
	planDir := filepath.Join(tempHome, ".ion", "plans")
	if err := os.MkdirAll(planDir, 0o755); err != nil {
		t.Fatalf("mkdir plans: %v", err)
	}
	planPath := filepath.Join(planDir, planSlug+".md")
	if err := os.WriteFile(planPath, []byte(planBody), 0o644); err != nil {
		t.Fatalf("write plan: %v", err)
	}

	// ── Run 1 — let the ApiBackend write real conversation history ────────────
	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	b.StartRun("run-1", types.RunOptions{
		Prompt:         "analyse the problem",
		Model:          "mock-model",
		ConversationID: convID,
	})
	be.waitForExit(t, 5*time.Second)

	// Verify run 1 produced a text chunk (sanity check — proves the backend
	// wrote history and the mock provider is wired correctly).
	var sawRun1Text bool
	for _, ev := range be.getNormalized() {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok && tc.Text == run1Text {
			sawRun1Text = true
		}
	}
	if !sawRun1Text {
		t.Fatal("run 1: expected text_chunk not received — ApiBackend or MockProvider not wired")
	}

	// Verify the conversation file now holds history (user + assistant pair).
	conv1, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("load after run 1: %v", err)
	}
	if len(conv1.Messages) < 2 {
		t.Fatalf("after run 1: Messages = %d, want >= 2 (user + assistant)", len(conv1.Messages))
	}

	// ── Plant the plan marker in the conversation tree ────────────────────────
	// The real engine would add this when the operator invokes a plan command.
	// For the test, add it directly and re-save so the plan-retention resolver
	// can find it.
	conversation.AppendEntry(conv1, conversation.EntryPlanMarker, conversation.PlanMarkerData{
		Operation:    "created",
		PlanFilePath: planPath,
		PlanSlug:     planSlug,
	})
	if err := conversation.Save(conv1, convDir); err != nil {
		t.Fatalf("save with plan marker: %v", err)
	}

	// ── /clear --keep-plan ────────────────────────────────────────────────────
	mgr := session.NewManager(helpers.NewMockBackend())
	keptSlug, err := mgr.ClearConversationFileWithOptions(convID, true)
	if err != nil {
		t.Fatalf("ClearConversationFileWithOptions: %v", err)
	}
	if keptSlug != planSlug {
		t.Fatalf("kept slug = %q, want %q", keptSlug, planSlug)
	}

	// Verify the conversation file state: exactly one message (the injected plan),
	// and the first run's history is gone.
	convAfterClear, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("load after clear: %v", err)
	}
	if len(convAfterClear.Messages) != 1 {
		t.Fatalf("after clear: Messages = %d, want 1 (injected plan only)", len(convAfterClear.Messages))
	}
	body, _ := json.Marshal(convAfterClear.Messages[0].Content)
	if !strings.Contains(string(body), "do the first step") {
		t.Errorf("injected message missing plan text: %s", body)
	}
	if strings.Contains(string(body), run1Text) {
		t.Errorf("injected message still contains run-1 text %q — clear did not wipe history", run1Text)
	}

	// ── Run 2 — second ApiBackend run on the same conversation ───────────────
	// Reset the collector; we want only run-2 events.
	be2 := newBackendCollector(b)

	b.StartRun("run-2", types.RunOptions{
		Prompt:         "continue",
		Model:          "mock-model",
		ConversationID: convID,
	})
	be2.waitForExit(t, 5*time.Second)

	// ── The core assertion: what did the LLM actually receive on run 2? ───────
	// MockProvider.Calls() records the LlmStreamOptions for every Stream() call.
	// Index 0 = run 1, index 1 = run 2.
	calls := mp.Calls()
	if len(calls) < 2 {
		t.Fatalf("MockProvider received %d Stream() calls, want >= 2", len(calls))
	}

	run2Messages := calls[1].Messages
	// The engine prepends the conversation's stored messages before the new
	// prompt, then appends the current prompt as the final user turn.
	// After --keep-plan the stored context is: [injected-plan].
	// After appending the "continue" prompt: [injected-plan, "continue"].
	// So run2Messages should have exactly 2 messages.
	if len(run2Messages) != 2 {
		t.Fatalf("run 2 LLM context: %d messages, want 2 (injected plan + new prompt); messages: %+v", len(run2Messages), run2Messages)
	}

	// The first message must be the retained plan, not the original run-1 turn.
	first, _ := json.Marshal(run2Messages[0].Content)
	if !strings.Contains(string(first), "do the first step") {
		t.Errorf("run 2 context[0]: missing plan text; got: %s", first)
	}
	if strings.Contains(string(first), run1Text) {
		t.Errorf("run 2 context[0]: contains run-1 history %q — not cleared", run1Text)
	}

	// The second message must be the new "continue" prompt.
	second, _ := json.Marshal(run2Messages[1].Content)
	if !strings.Contains(string(second), "continue") {
		t.Errorf("run 2 context[1]: expected 'continue' prompt, got: %s", second)
	}
}
