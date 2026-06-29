//go:build integration

package integration

// TestDispatchChildSpawner_RunloopPath is the regression pin for the
// production failure in conversation 1782764025664-b9b0e3f86ef7.
//
// Root cause: dispatch_agent.go assembled a child RunConfig without
// AgentSpawner. When the child's runloop executed the engine Agent tool
// (runloop_tools.go:35-53), AgentSpawnerFromContext returned nil, and the
// tool returned "Agent tool not available (no API backend configured)."
//
// The fix (dispatch_child_spawner.go + dispatch_agent.go line ~232) wires
// BuildChildAgentSpawner onto childCfg.AgentSpawner so the child's runloop
// gets a functional spawner. This test exercises exactly that path:
//
//  1. Dispatch a real depth-1 child via BuildDispatchAgentFunc (the
//     production code path in dispatch_agent.go, NOT TestNewExtContextWithOpts).
//  2. Script the mock provider so the child's first LLM call returns an
//     Agent tool use (depth-1 child invokes the engine Agent tool).
//  3. The Agent tool calls AgentSpawnerFromContext — must find a spawner
//     (the one placed on childCfg.AgentSpawner by the fix). Without the fix
//     this returns nil and the tool result is an error string.
//  4. The spawner dispatches a grandchild (depth-2). Script the grandchild's
//     LLM call to return "grandchild-result".
//  5. The child's second LLM call (after the Agent tool result) returns
//     "tier2-final". The overall dispatch completes with output "tier2-final".
//
// Must go RED against code without the fix (nil childCfg.AgentSpawner) and
// GREEN after the fix.

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

func TestDispatchChildSpawner_RunloopPath(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{
		ProviderID:      "mock",
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	mgr := session.NewManager(backend.NewApiBackend())

	cfg := types.EngineConfig{
		ProfileID:        "child-spawner-test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("cs-test", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("cs-test") })

	// ── Script the mock provider ──
	//
	// Call 1: depth-1 child's first turn. Returns an Agent tool use so the
	//         child's runloop exercises the AgentSpawner path.
	mp.SetResponse(helpers.ToolCallResponse("Agent", "agent_tool_001", map[string]interface{}{
		"prompt": "grandchild-task",
		"name":   "grandchild-agent",
		"model":  "mock-model",
	}))

	// Call 2: depth-2 grandchild's run. Returns text so it completes cleanly.
	mp.SetResponse(helpers.TextResponse("grandchild-result"))

	// Call 3: depth-1 child's second turn (after the Agent tool result).
	//         Returns final text to complete the child dispatch.
	mp.SetResponse(helpers.TextResponse("tier2-final"))

	// ── Dispatch via the root context (production path) ──
	// TestNewExtContext builds a depth-0 context, then DispatchAgent calls
	// BuildDispatchAgentFunc at childDepth=1 and assembles a real childCfg.
	// This exercises dispatch_agent.go lines 184-232 — the same path that
	// failed in production, not the TestNewExtContextWithOpts shortcut that
	// bypasses RunConfig assembly.
	rootCtx := mgr.TestNewExtContext("cs-test")
	if rootCtx == nil {
		t.Fatal("TestNewExtContext returned nil")
	}

	var (
		mu      sync.Mutex
		outcome *extension.DispatchAgentResult
		dispErr *extension.DispatchError
	)
	done := make(chan struct{})

	_, err := rootCtx.DispatchAgent(extension.DispatchAgentOpts{
		Name:     "depth1-agent",
		Task:     "Dispatch a grandchild and return its result.",
		Model:    "mock-model",
		MaxTurns: 5,
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) {
			mu.Lock()
			outcome = &r
			mu.Unlock()
			close(done)
		},
		OnError: func(e extension.DispatchError) {
			mu.Lock()
			dispErr = &e
			mu.Unlock()
			close(done)
		},
	})
	if err != nil {
		t.Fatalf("DispatchAgent: %v", err)
	}

	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("timeout waiting for depth1-agent dispatch")
	}

	mu.Lock()
	o := outcome
	de := dispErr
	mu.Unlock()

	// The dispatch must succeed: no DispatchError.
	if de != nil {
		t.Fatalf("depth1-agent dispatch error: exitCode=%d msg=%q — "+
			"this indicates childCfg.AgentSpawner was nil (pre-fix regression)",
			de.ExitCode, de.Message)
	}
	if o == nil {
		t.Fatal("depth1-agent: no outcome")
	}
	if o.ExitCode != 0 {
		t.Fatalf("depth1-agent exitCode=%d output=%q", o.ExitCode, o.Output)
	}

	// The depth-1 agent's final output is the text from call 3.
	if !strings.Contains(o.Output, "tier2-final") {
		t.Errorf("depth1-agent output=%q, want to contain \"tier2-final\"", o.Output)
	}

	// The grandchild must have run: the mock provider was called 3 times.
	// Call 1 = depth-1 init, call 2 = grandchild, call 3 = depth-1 final.
	if mp.CallCount() < 3 {
		t.Errorf("provider called %d times, want at least 3 (depth-1 init + grandchild + depth-1 final); "+
			"grandchild likely never dispatched due to nil spawner",
			mp.CallCount())
	}

	// Depth on the returned result must be 1 (the child we dispatched).
	if o.Depth != 1 {
		t.Errorf("depth1-agent result.Depth=%d want 1", o.Depth)
	}
}

// TestDispatchChildSpawner_DepthCapStillHolds verifies that the new child
// spawner wiring does not bypass the depth cap. A depth-2 agent whose
// runloop invokes the Agent tool must be blocked with ErrDispatchDepthExceeded,
// not allowed to create a depth-3 grandchild (which would reach depth 4 via
// another nesting).
//
// This exercises the same cap enforcement path as the depth guard in
// BuildDispatchAgentFunc (dispatch_agent.go lines 64-71), reached now via
// BuildChildAgentSpawner → BuildDispatchAgentFunc.
func TestDispatchChildSpawner_DepthCapStillHolds(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{
		ProviderID:      "mock",
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	mgr := session.NewManager(backend.NewApiBackend())

	cfg := types.EngineConfig{
		ProfileID:        "depth-cap-spawner-test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("dc-test", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("dc-test") })

	// Script three tiers of agent calls, each invoking the Agent tool.
	//
	// Call 1 (depth-1 child, first turn): Agent tool call to spawn depth-2.
	mp.SetResponse(helpers.ToolCallResponse("Agent", "agent_tool_d1", map[string]interface{}{
		"prompt": "depth2-task",
		"model":  "mock-model",
	}))
	// Call 2 (depth-2 grandchild, first turn): Agent tool call to spawn depth-3.
	// This should be BLOCKED by the cap (DefaultMaxDispatchDepth=3, childDepth 3 >= 3).
	mp.SetResponse(helpers.ToolCallResponse("Agent", "agent_tool_d2", map[string]interface{}{
		"prompt": "depth3-task-blocked",
		"model":  "mock-model",
	}))
	// Call 3 (depth-2 grandchild, second turn after the blocked tool result):
	// returns text to complete the grandchild.
	mp.SetResponse(helpers.TextResponse("grandchild-capped-output"))
	// Call 4 (depth-1 child, second turn after grandchild completes):
	// returns final text.
	mp.SetResponse(helpers.TextResponse("child-capped-output"))

	rootCtx := mgr.TestNewExtContext("dc-test")
	if rootCtx == nil {
		t.Fatal("TestNewExtContext returned nil")
	}

	var (
		mu      sync.Mutex
		outcome *extension.DispatchAgentResult
		dispErr *extension.DispatchError
	)
	done := make(chan struct{})

	_, err := rootCtx.DispatchAgent(extension.DispatchAgentOpts{
		Name:     "depth-cap-d1",
		Task:     "Try to nest three tiers; cap must block the third.",
		Model:    "mock-model",
		MaxTurns: 10,
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) {
			mu.Lock()
			outcome = &r
			mu.Unlock()
			close(done)
		},
		OnError: func(e extension.DispatchError) {
			mu.Lock()
			dispErr = &e
			mu.Unlock()
			close(done)
		},
	})
	if err != nil {
		t.Fatalf("DispatchAgent: %v", err)
	}

	select {
	case <-done:
	case <-time.After(25 * time.Second):
		t.Fatal("timeout waiting for depth-cap-d1 dispatch")
	}

	mu.Lock()
	o := outcome
	de := dispErr
	mu.Unlock()

	// The overall dispatch must complete (depth-1 and depth-2 both complete;
	// only the depth-3 attempt is blocked and surfaces as a tool error to the
	// depth-2 grandchild, which then returns its capped output on turn 2).
	if de != nil {
		t.Fatalf("unexpected dispatch error: exitCode=%d msg=%q", de.ExitCode, de.Message)
	}
	if o == nil {
		t.Fatal("depth-cap-d1: no outcome")
	}
	if o.ExitCode != 0 {
		t.Fatalf("depth-cap-d1 exitCode=%d output=%q", o.ExitCode, o.Output)
	}

	// The depth-3 dispatch must have been blocked — provider call 4 is call 3
	// in our script (grandchild second turn), not a new depth-3 call.
	// Verify no more than 4 provider calls occurred (no depth-3 agent ran).
	if mp.CallCount() > 4 {
		t.Errorf("provider called %d times, want ≤4; a depth-3 agent may have slipped through the cap",
			mp.CallCount())
	}
}
