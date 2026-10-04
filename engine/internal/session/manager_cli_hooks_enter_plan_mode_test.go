package session

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// wirePlanToolServer / enterPlanModeToolHandler tests.
//
// Split from manager_cli_hooks_test.go to stay under the file-size cap.

// planToolNames are the engine-owned plan tools a claude-code run registers.
var planToolNames = []string{"EnterPlanMode", "ExitPlanMode", "WritePlan", "EditPlan"}

// TestWirePlanToolServer_SameToolsInEveryMode pins the cache contract for the
// plan tools: a plan run, an auto run, and an implementation run register the
// same four tools and get the same alias directive. The set of tools a run
// registers is part of the prompt its provider caches, so it must not change
// with the mode.
func TestWirePlanToolServer_SameToolsInEveryMode(t *testing.T) {
	var directives []string
	for name, opts := range map[string]types.RunOptions{
		"auto":      {},
		"plan":      {PlanMode: true},
		"implement": {ImplementationPhase: true},
	} {
		mgr := NewManager(backend.NewClaudeCodeBackend())
		s := newCliSession("plan-tools-" + name)
		mgr.wirePlanToolServer(s, "plan-tools-"+name, &opts)

		mgr.mu.Lock()
		ts := s.toolServer
		mgr.mu.Unlock()
		if ts == nil {
			t.Fatalf("%s: expected a ToolServer for claude-code", name)
		}
		for _, tool := range planToolNames {
			if !ts.HasTool(tool) {
				t.Errorf("%s: %s must be registered in every mode", name, tool)
			}
		}
		if opts.McpConfig == "" {
			t.Errorf("%s: expected McpConfig to be attached", name)
		}
		directives = append(directives, opts.AppendSystemPrompt)
		ts.Stop()
	}
	for _, d := range directives[1:] {
		if d != directives[0] {
			t.Fatalf("the alias directive differs by mode:\n%q\n%q", directives[0], d)
		}
	}
	if !strings.Contains(directives[0], "ExitPlanMode = mcp__ion-extensions__ExitPlanMode") {
		t.Errorf("expected the plan tool alias directive, got: %q", directives[0])
	}
}

// TestWirePlanToolServer_NoopForNonCliBackend verifies the wiring is scoped to
// claude-code: an API-backed run gets its plan sentinels through the in-process
// runloop, not the MCP ToolServer.
func TestWirePlanToolServer_NoopForNonCliBackend(t *testing.T) {
	mgr := NewManager(newMockBackend())
	s := newCliSession("plan-tools-api")

	opts := types.RunOptions{PlanMode: true}
	mgr.wirePlanToolServer(s, "plan-tools-api", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()
	if ts != nil {
		t.Error("expected no ToolServer for non-CLI backend")
	}
	if opts.McpConfig != "" {
		t.Error("expected no McpConfig for non-CLI backend")
	}
}

// TestEnterPlanModeToolHandler_FlipsSessionStateAndEmitsEvent pins the actual
// state transition the handler performs when a claude-code model calls
// EnterPlanMode: the session flips into plan mode (so the NEXT turn's
// opts.PlanMode is true and buildClaudeArgs spawns read-only), and
// engine_plan_mode_changed is emitted for consumers. Reverting the handler to
// a bare acknowledgment (like planModeExitToolHandler) turns this red.
func TestEnterPlanModeToolHandler_FlipsSessionStateAndEmitsEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("enter-handler1", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	var mu sync.Mutex
	var sawEvent *types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_plan_mode_changed" {
			mu.Lock()
			e := ev
			sawEvent = &e
			mu.Unlock()
		}
	})

	handler := enterPlanModeToolHandler(mgr, "enter-handler1")
	res, err := handler(context.Background(), map[string]interface{}{})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", res.Content)
	}

	enabled, planFilePath := mgr.GetPlanModeState("enter-handler1")
	if !enabled {
		t.Error("expected session to be flipped into plan mode")
	}
	if planFilePath == "" {
		t.Error("expected a plan file path to be allocated")
	}

	mu.Lock()
	got := sawEvent
	mu.Unlock()
	if got == nil {
		t.Fatal("expected engine_plan_mode_changed to be emitted")
	}
	if !got.PlanModeEnabled {
		t.Error("expected PlanModeEnabled=true on the emitted event")
	}
	if got.PlanModeFilePath != planFilePath {
		t.Errorf("expected PlanModeFilePath=%q, got %q", planFilePath, got.PlanModeFilePath)
	}
}

// TestEnterPlanModeToolHandler_DeniedByHook verifies a before_plan_mode_enter
// hook veto leaves the session in auto mode and returns the denial reason as
// the tool result, without emitting engine_plan_mode_changed.
func TestEnterPlanModeToolHandler_DeniedByHook(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("enter-handler2", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	const denyReason = "extension says no"
	falseVal := false
	mgr.mu.Lock()
	s := mgr.sessions["enter-handler2"]
	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}
	host := extension.NewHost()
	s.extGroup.Add(host)
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &falseVal, Reason: denyReason}, nil
	})
	mgr.mu.Unlock()

	var mu sync.Mutex
	var sawEvent bool
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_plan_mode_changed" {
			mu.Lock()
			sawEvent = true
			mu.Unlock()
		}
	})

	handler := enterPlanModeToolHandler(mgr, "enter-handler2")
	res, err := handler(context.Background(), map[string]interface{}{})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", res.Content)
	}
	if res.Content != denyReason {
		t.Errorf("expected denial reason in tool result, got %q", res.Content)
	}

	enabled, _ := mgr.GetPlanModeState("enter-handler2")
	if enabled {
		t.Error("expected session to remain in auto mode after denial")
	}

	mu.Lock()
	got := sawEvent
	mu.Unlock()
	if got {
		t.Error("expected no engine_plan_mode_changed on denial")
	}
}

// TestEnterPlanModeToolHandler_NoRestartNoQueuedContinuation pins the
// corrected design: the model keeps running in the SAME claude-code
// subprocess after calling EnterPlanMode — no queued continuation prompt, no
// "turn ends here" framing. This mirrors the ApiBackend's
// interceptEnterPlanMode, which flips activeRun.planMode and lets that same
// run continue with no restart. Reintroducing a queued SendPrompt
// continuation (the prior, incorrect design) turns this red.
func TestEnterPlanModeToolHandler_NoRestartNoQueuedContinuation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "enter-handler3"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Simulate the handler firing mid-turn: a claude-code subprocess is still
	// running this exact request when the model calls EnterPlanMode.
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.requestID = "in-flight-run"
	mgr.mu.Unlock()

	handler := enterPlanModeToolHandler(mgr, key)
	res, err := handler(context.Background(), map[string]interface{}{})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", res.Content)
	}
	if strings.Contains(res.Content, "turn ends here") {
		t.Errorf("tool result must not claim the turn ends here; got %q", res.Content)
	}
	if !strings.Contains(res.Content, "ExitPlanMode") {
		t.Errorf("tool result must instruct the model to call ExitPlanMode; got %q", res.Content)
	}

	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	if s.requestID != "in-flight-run" {
		t.Fatalf("expected the in-flight run to be untouched, got requestID=%q", s.requestID)
	}
	if len(s.promptQueue) != 0 {
		t.Fatalf("expected no queued continuation prompt (no restart), got %d queued", len(s.promptQueue))
	}
}
