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

// wireEnterPlanModeToolServer / enterPlanModeToolHandler tests.
//
// Split from manager_cli_hooks_test.go to stay under the file-size cap.

// TestWireEnterPlanModeToolServer_RegistersForCliAutoMode pins the gap this
// closes: previously only the ApiBackend's in-process runloop exposed
// EnterPlanMode, so a delegated claude-code CLI run had no way to request a
// transition into plan mode at all.
func TestWireEnterPlanModeToolServer_RegistersForCliAutoMode(t *testing.T) {
	cb := backend.NewClaudeCodeBackend()
	mgr := NewManager(cb)
	s := newCliSession("enter-ts1")

	opts := types.RunOptions{PlanMode: false}
	mgr.wireEnterPlanModeToolServer(s, "enter-ts1", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	if ts == nil {
		t.Fatal("expected ToolServer to be created for claude-code auto mode")
	}
	if !ts.HasTool("EnterPlanMode") {
		t.Error("expected EnterPlanMode to be registered on the auto-mode ToolServer")
	}
	if opts.McpConfig == "" {
		t.Error("expected McpConfig to be attached")
	}
	if !strings.Contains(opts.AppendSystemPrompt, "EnterPlanMode = mcp__ion-extensions__EnterPlanMode") {
		t.Errorf("expected the EnterPlanMode alias directive, got: %q", opts.AppendSystemPrompt)
	}
	ts.Stop()
}

// TestWireEnterPlanModeToolServer_NoopWhenAlreadyPlanMode verifies the
// sentinel is not registered on a run already in plan mode — ExitPlanMode is
// the tool for that turn, not this one.
func TestWireEnterPlanModeToolServer_NoopWhenAlreadyPlanMode(t *testing.T) {
	cb := backend.NewClaudeCodeBackend()
	mgr := NewManager(cb)
	s := newCliSession("enter-ts2")

	opts := types.RunOptions{PlanMode: true}
	mgr.wireEnterPlanModeToolServer(s, "enter-ts2", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	if ts != nil {
		t.Error("expected no ToolServer when already in plan mode")
	}
}

// TestWireEnterPlanModeToolServer_NoopWhenImplementationPhase mirrors the
// ApiBackend's runloop_setup.go suppression: RunOptions.ImplementationPhase
// skips the EnterPlanMode injection so the model cannot propose a fresh plan
// mid-implementation. Same flag, same behavior, on the CLI path.
func TestWireEnterPlanModeToolServer_NoopWhenImplementationPhase(t *testing.T) {
	cb := backend.NewClaudeCodeBackend()
	mgr := NewManager(cb)
	s := newCliSession("enter-ts3")

	opts := types.RunOptions{PlanMode: false, ImplementationPhase: true}
	mgr.wireEnterPlanModeToolServer(s, "enter-ts3", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	if ts != nil {
		t.Error("expected no ToolServer during implementation phase")
	}
}

// TestWireEnterPlanModeToolServer_NoopForNonCliBackend verifies the wiring is
// scoped to claude-code: an API-backed run gets EnterPlanMode through the
// in-process runloop (interceptEnterPlanMode), not the MCP ToolServer.
func TestWireEnterPlanModeToolServer_NoopForNonCliBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	s := newCliSession("enter-ts4")

	opts := types.RunOptions{PlanMode: false}
	mgr.wireEnterPlanModeToolServer(s, "enter-ts4", &opts)

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
