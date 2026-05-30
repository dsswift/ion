//go:build e2e

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Shared lifecycle helpers ─────────────────────────────────────────────────

// findSessionID extracts the sessionID from the last engine_status idle event.
func findSessionID(events []types.EngineEvent) string {
	for i := len(events) - 1; i >= 0; i-- {
		ev := events[i]
		if ev.Type == "engine_status" && ev.Fields != nil &&
			ev.Fields.State == "idle" && ev.Fields.SessionID != "" {
			return ev.Fields.SessionID
		}
	}
	return ""
}

// ─── Test 6: Plan → Implement → Re-plan gets a fresh plan file ──────────────
//
// This is the exact flow that broke (Issue 1). After implementing a plan,
// re-entering plan mode should allocate a fresh plan slug, not reuse the old
// one. The desktop clears tab.planFilePath on implement (Fix 1), and the
// engine allocates a new slug when planFilePath is empty.
func TestLivePlanModeReplanAfterImplementGetsNewSlug(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	workDir := t.TempDir()
	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-replan",
		WorkingDirectory: workDir,
	}

	const key = "e2e-plan-replan"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	// ── Phase 1: Plan ──
	t.Log("Phase 1: Plan mode — create a plan")
	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Create a brief plan for adding a greet() function to a Go file. "+
			"Write the plan to the plan file, then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt (plan): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	planEvents := pc.getEvents()

	planFilePath1 := findPlanFilePath(planEvents)
	if planFilePath1 == "" {
		t.Fatal("no planFilePath from plan phase")
	}
	t.Cleanup(func() { os.Remove(planFilePath1) })
	t.Logf("Phase 1 plan file: %s", planFilePath1)

	if hasErrors(planEvents) {
		for _, ev := range filterEvents(planEvents, "engine_error") {
			t.Errorf("engine_error (plan): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	// ── Phase 2: Implement ──
	// Simulate the desktop's onImplement flow: stop session, start fresh,
	// do NOT pass the old planFilePath (matches Fix 1: desktop clears it).
	t.Log("Phase 2: Auto mode — implement the plan")
	mgr.SetPlanMode(key, false, nil, "implement")
	mgr.StopSession(key)

	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession (implement): %v", err)
	}

	pc.reset()

	planContent, err := os.ReadFile(planFilePath1)
	if err != nil {
		t.Fatalf("failed to read plan file: %v", err)
	}

	implementPrompt := "Implement the following plan:\n\n" + string(planContent)
	err = mgr.SendPrompt(key, implementPrompt, nil)
	if err != nil {
		t.Fatalf("SendPrompt (implement): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)

	// Verify plan file from Phase 1 still exists on disk
	if _, err := os.Stat(planFilePath1); err != nil {
		t.Errorf("plan file from Phase 1 should still exist: %v", err)
	}

	// ── Phase 3: Re-plan ──
	// Enable plan mode again. Do NOT pass old planFilePath (desktop cleared it).
	t.Log("Phase 3: Plan mode again — should get a fresh plan slug")

	pc.reset()
	mgr.SetPlanMode(key, true, nil, "test")

	err = mgr.SendPrompt(key,
		"Create a brief plan for adding a farewell() function to a Go file. "+
			"Write the plan to the plan file, then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt (re-plan): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	replanEvents := pc.getEvents()

	planFilePath2 := findPlanFilePath(replanEvents)
	if planFilePath2 == "" {
		t.Fatal("no planFilePath from re-plan phase")
	}
	t.Cleanup(func() { os.Remove(planFilePath2) })
	t.Logf("Phase 3 plan file: %s", planFilePath2)

	// Core assertion: the two plan files must be different slugs.
	if planFilePath1 == planFilePath2 {
		t.Errorf("re-plan should get a fresh plan file, but got the same: %s", planFilePath1)
	}

	// Both files should exist with non-trivial content.
	for _, p := range []string{planFilePath1, planFilePath2} {
		info, err := os.Stat(p)
		if err != nil {
			t.Errorf("plan file %s does not exist: %v", p, err)
			continue
		}
		if info.Size() < 20 {
			t.Errorf("plan file %s too small (%d bytes)", p, info.Size())
		}
	}

	// Extract slugs (filename without .md) and verify they differ.
	slug1 := strings.TrimSuffix(filepath.Base(planFilePath1), ".md")
	slug2 := strings.TrimSuffix(filepath.Base(planFilePath2), ".md")
	if slug1 == slug2 {
		t.Errorf("plan slugs should differ: slug1=%s slug2=%s", slug1, slug2)
	}

	if hasErrors(replanEvents) {
		for _, ev := range filterEvents(replanEvents, "engine_error") {
			t.Errorf("engine_error (re-plan): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	t.Logf("Re-plan OK: slug1=%s slug2=%s", slug1, slug2)
}

// ─── Test 7: Re-plan with stale planFilePath reuses it (negative control) ────
//
// When the desktop passes the old planFilePath (toggle without implementing),
// the engine should reuse it rather than allocating a fresh slug.
func TestLivePlanModeReplanWithStalePlanFilePathReusesIt(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-reuse",
		WorkingDirectory: t.TempDir(),
	}

	const key = "e2e-plan-reuse"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	// ── Phase 1: Plan ──
	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Create a brief plan for adding a sum() function. "+
			"Write the plan to the plan file, then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events1 := pc.getEvents()

	planFilePath1 := findPlanFilePath(events1)
	if planFilePath1 == "" {
		t.Fatal("no planFilePath from Phase 1")
	}
	t.Cleanup(func() { os.Remove(planFilePath1) })
	t.Logf("Phase 1 plan file: %s", planFilePath1)

	// ── Phase 2: Toggle plan mode off and back on (without implementing) ──
	// This simulates the desktop's toggle behavior where planFilePath is
	// preserved in tab state and passed back as an override.
	mgr.SetPlanMode(key, false, nil, "toggle")
	mgr.SetPlanMode(key, true, nil, "toggle")

	pc.reset()

	// Send second prompt WITH the old planFilePath override.
	err = mgr.SendPrompt(key,
		"Add a multiply() function to the plan. "+
			"Update the plan file, then call ExitPlanMode.",
		&session.PromptOverrides{PlanFilePath: planFilePath1})
	if err != nil {
		t.Fatalf("SendPrompt (re-plan): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events2 := pc.getEvents()

	planFilePath2 := findPlanFilePath(events2)
	if planFilePath2 == "" {
		t.Fatal("no planFilePath from Phase 2")
	}

	// Core assertion: plan file should be the same (reused, not fresh).
	if planFilePath2 != planFilePath1 {
		t.Errorf("expected plan file to be reused: got %s, want %s", planFilePath2, planFilePath1)
	}

	if hasErrors(events2) {
		for _, ev := range filterEvents(events2, "engine_error") {
			t.Errorf("engine_error (re-plan): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	t.Logf("Plan file reuse OK: %s", planFilePath1)
}

// ─── Test 8: Conversation history survives plan mode toggle ──────────────────
//
// Verifies that toggling plan mode does NOT destroy conversation context
// (Issue 2). The model should remember content from the prior run when
// the conversation is loaded for the plan-mode run.
func TestLivePlanModeConversationContinuity(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-continuity",
		WorkingDirectory: t.TempDir(),
	}

	const key = "e2e-plan-continuity"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	// ── Phase 1: Auto mode — establish a codeword ──
	t.Log("Phase 1: Auto mode — remember a codeword")
	err := mgr.SendPrompt(key,
		"Remember this codeword: TIGER. Respond with exactly 'Acknowledged: TIGER' and nothing else.", nil)
	if err != nil {
		t.Fatalf("SendPrompt (codeword): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events1 := pc.getEvents()

	sessionID := findSessionID(events1)
	if sessionID == "" {
		t.Fatal("no sessionID from Phase 1")
	}
	t.Logf("Phase 1 sessionID: %s", sessionID)

	if hasErrors(events1) {
		for _, ev := range filterEvents(events1, "engine_error") {
			t.Errorf("engine_error (codeword): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	// ── Phase 2: Plan mode — reference the codeword ──
	t.Log("Phase 2: Plan mode — reference the codeword in the plan")
	pc.reset()
	mgr.SetPlanMode(key, true, nil, "test")

	err = mgr.SendPrompt(key,
		"Create a plan that references the codeword I gave you earlier. "+
			"Include the exact codeword in the plan file. "+
			"Write the plan to the plan file, then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt (plan): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events2 := pc.getEvents()

	planFilePath := findPlanFilePath(events2)
	if planFilePath == "" {
		t.Fatal("no planFilePath from Phase 2")
	}
	t.Cleanup(func() { os.Remove(planFilePath) })

	// The model should have included "TIGER" in the plan file — it can
	// only know this if it loaded the prior conversation history.
	planContent, err := os.ReadFile(planFilePath)
	if err != nil {
		t.Fatalf("failed to read plan file: %v", err)
	}
	if !strings.Contains(strings.ToUpper(string(planContent)), "TIGER") {
		// Also check the model's text output for TIGER
		foundInText := false
		for _, ev := range filterEvents(events2, "engine_text_delta") {
			if strings.Contains(strings.ToUpper(ev.TextDelta), "TIGER") {
				foundInText = true
				break
			}
		}
		if !foundInText {
			t.Errorf("expected TIGER in plan file or model output (conversation context was lost).\nPlan content: %s",
				string(planContent)[:min(500, len(planContent))])
		}
	}

	// Verify conversation on disk has messages from both runs.
	conv, loadErr := conversation.Load(sessionID, "")
	if loadErr != nil {
		t.Fatalf("failed to load conversation %s: %v", sessionID, loadErr)
	}
	if len(conv.Messages) <= 2 {
		t.Errorf("expected more than 2 messages in conversation (both runs), got %d", len(conv.Messages))
	}

	if hasErrors(events2) {
		for _, ev := range filterEvents(events2, "engine_error") {
			t.Errorf("engine_error (plan): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	t.Logf("Conversation continuity OK: sessionID=%s messages=%d planFile=%s",
		sessionID, len(conv.Messages), planFilePath)
}
