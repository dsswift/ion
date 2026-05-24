//go:build e2e

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Shared helpers ───────────────────────────────────────────────────────────

// planEventCollector collects EngineEvents from a Manager and provides
// helpers for waiting and querying plan-mode-specific events.
type planEventCollector struct {
	mu     sync.Mutex
	events []types.EngineEvent
	done   chan struct{}
	closed bool
}

func newPlanEventCollector(mgr *session.Manager) *planEventCollector {
	pc := &planEventCollector{done: make(chan struct{})}
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		pc.mu.Lock()
		defer pc.mu.Unlock()
		pc.events = append(pc.events, ev)
		// Signal completion when we see idle with a sessionID (run finished).
		if ev.Type == "engine_status" && ev.Fields != nil &&
			ev.Fields.State == "idle" && ev.Fields.SessionID != "" {
			if !pc.closed {
				pc.closed = true
				close(pc.done)
			}
		}
	})
	return pc
}

func (pc *planEventCollector) waitForIdle(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-pc.done:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for idle")
	}
}

// reset prepares the collector for a second run.
func (pc *planEventCollector) reset() {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	pc.events = nil
	pc.done = make(chan struct{})
	pc.closed = false
}

func (pc *planEventCollector) getEvents() []types.EngineEvent {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	out := make([]types.EngineEvent, len(pc.events))
	copy(out, pc.events)
	return out
}

func filterEvents(events []types.EngineEvent, eventType string) []types.EngineEvent {
	var out []types.EngineEvent
	for _, ev := range events {
		if ev.Type == eventType {
			out = append(out, ev)
		}
	}
	return out
}

// findPlanFilePath extracts the planFilePath from the ExitPlanMode
// permission denial carried on engine_status. The engine no longer emits
// PlanModeChangedEvent{Enabled:false} on the model's ExitPlanMode call —
// that call is a *proposal*, not a confirmed mode change. The run-end
// signal is engine_status (task_complete) with the ExitPlanMode denial
// carrying planFilePath in toolInput.
func findPlanFilePath(events []types.EngineEvent) string {
	for _, ev := range events {
		if ev.Type != "engine_status" || ev.Fields == nil {
			continue
		}
		for _, d := range ev.Fields.PermissionDenials {
			if d.ToolName == "ExitPlanMode" && d.ToolInput != nil {
				if p, ok := d.ToolInput["planFilePath"].(string); ok && p != "" {
					return p
				}
			}
		}
	}
	return ""
}

// findPlanProposal returns the first engine_plan_proposal event with the
// given kind, or nil if none was observed. The plan_proposal event is the
// first-class workflow signal that the model has proposed a plan-mode
// transition; see docs/architecture/adr/003-state-events-vs-workflow-events.md
// for the state-vs-workflow distinction.
func findPlanProposal(events []types.EngineEvent, kind string) *types.EngineEvent {
	for i, ev := range events {
		if ev.Type == "engine_plan_proposal" && ev.PlanProposalKind == kind {
			return &events[i]
		}
	}
	return nil
}

func hasErrors(events []types.EngineEvent) bool {
	for _, ev := range events {
		if ev.Type == "engine_error" {
			return true
		}
	}
	return false
}

// ─── Test 1: Enter and exit plan mode ─────────────────────────────────────────
//
// Verifies the full plan mode lifecycle through the Manager pipeline:
// SetPlanMode → SendPrompt → PlanModeChangedEvent{Enabled:true} →
// model calls ExitPlanMode → PlanModeChangedEvent{Enabled:false} with
// planFilePath → TaskComplete with ExitPlanMode in permissionDenials.
func TestLiveCliPlanModeEnterAndExit(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-enter-exit",
		WorkingDirectory: t.TempDir(),
	}

	const key = "e2e-plan-ee"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Create a brief plan for adding a hello() function to a Go file. "+
			"Write the plan to the plan file, then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events := pc.getEvents()

	// Should have PlanModeChanged enabled=true
	planEnter := filterEvents(events, "engine_plan_mode_changed")
	foundEnter := false
	for _, ev := range planEnter {
		if ev.PlanModeEnabled {
			foundEnter = true
		}
	}
	if !foundEnter {
		t.Error("expected engine_plan_mode_changed with planModeEnabled=true")
	}

	// Should expose planFilePath via the ExitPlanMode denial on engine_status.
	// The engine no longer emits PlanModeChangedEvent{Enabled:false} on the
	// model's ExitPlanMode call (deferred to user approval).
	planPath := findPlanFilePath(events)
	if planPath == "" {
		t.Error("expected ExitPlanMode denial on engine_status to carry planFilePath")
	}
	for _, ev := range planEnter {
		if !ev.PlanModeEnabled {
			t.Error("unexpected engine_plan_mode_changed{planModeEnabled=false} (must be deferred to user approval)")
		}
	}

	// Should expose the model's ExitPlanMode call as a first-class
	// plan_proposal{kind:"exit"} workflow event with the planFilePath
	// and planSlug carried directly (no permissionDenials scraping needed).
	proposal := findPlanProposal(events, "exit")
	if proposal == nil {
		t.Error("expected engine_plan_proposal{kind:\"exit\"} after model ExitPlanMode tool call")
	} else {
		if proposal.PlanModeFilePath == "" {
			t.Error("engine_plan_proposal should carry a non-empty planFilePath")
		}
		if proposal.PlanModeFilePath != planPath {
			t.Errorf("plan_proposal planFilePath=%q does not match denial planFilePath=%q",
				proposal.PlanModeFilePath, planPath)
		}
		if proposal.PlanModeSlug == "" && proposal.PlanModeFilePath != "" {
			t.Error("engine_plan_proposal should carry a non-empty planSlug when planFilePath is non-empty")
		}
	}

	// Should have permission denials with ExitPlanMode
	statusEvents := filterEvents(events, "engine_status")
	foundExitDenial := false
	for _, ev := range statusEvents {
		if ev.Fields == nil {
			continue
		}
		for _, d := range ev.Fields.PermissionDenials {
			if d.ToolName == "ExitPlanMode" {
				foundExitDenial = true
				if d.ToolInput == nil || d.ToolInput["planFilePath"] == nil {
					t.Error("ExitPlanMode denial should have planFilePath in toolInput")
				}
			}
		}
	}
	if !foundExitDenial {
		t.Error("expected ExitPlanMode in permission denials")
	}

	if hasErrors(events) {
		for _, ev := range filterEvents(events, "engine_error") {
			t.Errorf("engine_error: %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	// Clean up plan file
	if planPath != "" {
		t.Cleanup(func() { os.Remove(planPath) })
	}

	t.Logf("Plan mode enter/exit OK: planFilePath=%s", planPath)
}

// ─── Test 2: Plan file is generated on disk ───────────────────────────────────
//
// Verifies that the model actually writes a plan to the managed file path
// at ~/.ion/plans/*.md with real content.
func TestLiveCliPlanModeGeneratesPlanFile(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-file",
		WorkingDirectory: t.TempDir(),
	}

	const key = "e2e-plan-file"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Plan how to create a simple calculator module in Go with add, subtract, "+
			"multiply, and divide functions. Write a detailed plan to the plan file. "+
			"Then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events := pc.getEvents()

	planPath := findPlanFilePath(events)
	if planPath == "" {
		t.Fatal("no planFilePath in events")
	}

	t.Cleanup(func() { os.Remove(planPath) })

	// Should match a .ion/plans/*.md pattern (either ~/.ion/plans/ for API or project/.ion/plans/ for CLI)
	if !strings.Contains(planPath, filepath.Join(".ion", "plans")) || !strings.HasSuffix(planPath, ".md") {
		t.Errorf("planFilePath should contain .ion/plans/*.md, got: %s", planPath)
	}

	// File should exist on disk
	info, err := os.Stat(planPath)
	if err != nil {
		t.Fatalf("plan file does not exist at %s: %v", planPath, err)
	}

	// File should have real content (not empty or stub)
	if info.Size() < 50 {
		t.Errorf("plan file too small (%d bytes), expected substantial content", info.Size())
	}

	content, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("failed to read plan file: %v", err)
	}

	lower := strings.ToLower(string(content))
	hasKeyword := strings.Contains(lower, "calculator") ||
		strings.Contains(lower, "add") ||
		strings.Contains(lower, "function") ||
		strings.Contains(lower, "subtract")
	if !hasKeyword {
		t.Errorf("plan file should contain relevant keywords, got:\n%s",
			string(content)[:min(500, len(content))])
	}

	if hasErrors(events) {
		for _, ev := range filterEvents(events, "engine_error") {
			t.Errorf("engine_error: %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	t.Logf("Plan file OK: %s (%d bytes)", planPath, info.Size())
}

// ─── Test 3: Full plan → implement lifecycle ──────────────────────────────────
//
// Mirrors the desktop "Implement" button flow: plan mode produces a plan file,
// then auto mode implements it by sending the plan content as a new prompt.
func TestLiveCliPlanModeImplementFlow(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	workDir := t.TempDir()
	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-impl",
		WorkingDirectory: workDir,
	}

	const key = "e2e-plan-impl"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	// ── Phase 1: Plan ──
	t.Log("Phase 1: Plan mode — create a plan")
	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Plan how to create a file called hello.txt in the working directory "+
			"containing exactly 'Hello, World!'. Write the plan to the plan file. "+
			"Then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt (plan): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	planEvents := pc.getEvents()

	planPath := findPlanFilePath(planEvents)
	if planPath == "" {
		t.Fatal("no planFilePath from plan phase")
	}
	t.Cleanup(func() { os.Remove(planPath) })

	// Read plan content
	planContent, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("failed to read plan file: %v", err)
	}
	if len(planContent) < 10 {
		t.Fatalf("plan file too small (%d bytes)", len(planContent))
	}
	t.Logf("Plan content (%d bytes): %s", len(planContent),
		string(planContent)[:min(200, len(planContent))])

	// hello.txt should NOT exist yet (plan mode is read-only)
	if _, err := os.Stat(filepath.Join(workDir, "hello.txt")); err == nil {
		t.Error("hello.txt should not exist after plan phase (plan mode is read-only)")
	}

	// ── Phase 2: Implement ──
	t.Log("Phase 2: Auto mode — implement the plan")

	// Switch to auto mode and start a fresh session (mirrors desktop behavior)
	mgr.SetPlanMode(key, false, nil, "implement")
	mgr.StopSession(key)

	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession (implement): %v", err)
	}

	pc.reset()

	implementPrompt := "Implement the following plan:\n\n" + string(planContent)
	err = mgr.SendPrompt(key, implementPrompt, nil)
	if err != nil {
		t.Fatalf("SendPrompt (implement): %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	implEvents := pc.getEvents()

	// Should NOT have PlanModeChangedEvent (we're in auto mode now)
	planModeEvents := filterEvents(implEvents, "engine_plan_mode_changed")
	if len(planModeEvents) > 0 {
		t.Error("implement phase should not have engine_plan_mode_changed events")
	}

	// hello.txt should now exist with correct content
	helloPath := filepath.Join(workDir, "hello.txt")
	helloContent, err := os.ReadFile(helloPath)
	if err != nil {
		t.Fatalf("hello.txt not created: %v", err)
	}
	if !strings.Contains(string(helloContent), "Hello, World!") {
		t.Errorf("hello.txt should contain 'Hello, World!', got: %q", string(helloContent))
	}

	if hasErrors(implEvents) {
		for _, ev := range filterEvents(implEvents, "engine_error") {
			t.Errorf("engine_error (implement): %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	t.Logf("Implement flow OK: hello.txt created with %q", strings.TrimSpace(string(helloContent)))
}

// ─── Test 4: Plan mode restricts tool access ──────────────────────────────────
//
// Verifies that the CLI's native plan mode prevents the model from modifying
// arbitrary files — only the plan file should be writable.
func TestLiveCliPlanModeToolRestriction(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	workDir := t.TempDir()

	// Create a target file that should NOT be modified
	targetPath := filepath.Join(workDir, "target.txt")
	originalContent := "ORIGINAL CONTENT - DO NOT MODIFY"
	if err := os.WriteFile(targetPath, []byte(originalContent), 0o644); err != nil {
		t.Fatalf("failed to create target.txt: %v", err)
	}

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-restrict",
		WorkingDirectory: workDir,
	}

	const key = "e2e-plan-restrict"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"Write the text 'MODIFIED' to the file target.txt in the working directory. "+
			"Then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events := pc.getEvents()

	// target.txt should still have its original content
	afterContent, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("failed to read target.txt after run: %v", err)
	}
	if string(afterContent) != originalContent {
		t.Errorf("target.txt was modified in plan mode!\n  expected: %q\n  got:      %q",
			originalContent, string(afterContent))
	} else {
		t.Log("Plan mode tool restriction OK: target.txt was not modified")
	}

	// Clean up plan file if one was created
	planPath := findPlanFilePath(events)
	if planPath != "" {
		t.Cleanup(func() { os.Remove(planPath) })
	}
}

// ─── Test 5: Full Manager pipeline produces correct events ────────────────────
//
// Verifies the complete Manager pipeline: SetPlanMode → SendPrompt →
// buildRunOptions → CliBackend.StartRun, and that the resulting event
// stream contains all expected event types in the correct order.
func TestLiveCliPlanModeViaManagerSendPrompt(t *testing.T) {
	parentBackend := backend.NewCliBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-plan-pipeline",
		WorkingDirectory: t.TempDir(),
	}

	const key = "e2e-plan-pipeline"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	pc := newPlanEventCollector(mgr)

	mgr.SetPlanMode(key, true, nil, "test")

	err := mgr.SendPrompt(key,
		"What is 2+2? Write a very brief plan that simply states the answer is 4. "+
			"Write it to the plan file. Then call ExitPlanMode.", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	pc.waitForIdle(t, 90*time.Second)
	events := pc.getEvents()

	// Should have text_delta events (model produced text)
	textDeltas := filterEvents(events, "engine_text_delta")
	if len(textDeltas) == 0 {
		t.Error("expected engine_text_delta events")
	}

	// Should have engine_plan_mode_changed with enabled=true. The engine
	// must NOT emit enabled=false on the model's ExitPlanMode call — that
	// is a *proposal* awaiting user approval; the run-end signal is the
	// ExitPlanMode denial on engine_status.
	planChanged := filterEvents(events, "engine_plan_mode_changed")
	foundEnabled := false
	for _, ev := range planChanged {
		if ev.PlanModeEnabled {
			foundEnabled = true
		} else {
			t.Error("unexpected engine_plan_mode_changed{planModeEnabled=false} (must be deferred to user approval)")
		}
	}
	if !foundEnabled {
		t.Error("expected engine_plan_mode_changed with planModeEnabled=true")
	}

	// Should have engine_status (task complete)
	statusEvents := filterEvents(events, "engine_status")
	foundComplete := false
	for _, ev := range statusEvents {
		if ev.Fields != nil && ev.Fields.State == "idle" && ev.Fields.SessionID != "" {
			foundComplete = true
		}
	}
	if !foundComplete {
		t.Error("expected engine_status with state=idle (task complete)")
	}

	// Should NOT have engine_dead
	deadEvents := filterEvents(events, "engine_dead")
	if len(deadEvents) > 0 {
		t.Errorf("unexpected engine_dead events: %d", len(deadEvents))
	}

	// Should NOT have engine_error
	if hasErrors(events) {
		for _, ev := range filterEvents(events, "engine_error") {
			t.Errorf("engine_error: %s (code: %s)", ev.EventMessage, ev.ErrorCode)
		}
	}

	// Plan file should exist
	planPath := findPlanFilePath(events)
	if planPath != "" {
		if _, err := os.Stat(planPath); err != nil {
			t.Errorf("plan file does not exist at %s: %v", planPath, err)
		}
		t.Cleanup(func() { os.Remove(planPath) })
	}

	t.Logf("Manager pipeline OK: %d text deltas, %d plan_mode_changed events, planFile=%s",
		len(textDeltas), len(planChanged), planPath)
}
