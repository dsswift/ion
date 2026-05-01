package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestSetPlanMode_Enable(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("plan", defaultConfig())

	mgr.SetPlanMode("plan", true, []string{"Read", "Grep"}, "")

	_ = mgr.SendPrompt("plan", "plan it", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if !opts.PlanMode {
		t.Error("expected PlanMode=true in RunOptions")
	}
	if len(opts.PlanModeTools) != 2 {
		t.Errorf("expected 2 plan mode tools, got %d", len(opts.PlanModeTools))
	}
}

func TestSetPlanMode_Disable(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("plan2", defaultConfig())

	mgr.SetPlanMode("plan2", true, []string{"Read"}, "")
	mgr.SetPlanMode("plan2", false, nil, "")

	_ = mgr.SendPrompt("plan2", "execute", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if opts.PlanMode {
		t.Error("expected PlanMode=false after disable")
	}
	if len(opts.PlanModeTools) != 0 {
		t.Errorf("expected 0 plan mode tools, got %d", len(opts.PlanModeTools))
	}
}

func TestSetPlanMode_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Should not panic
	mgr.SetPlanMode("ghost", true, []string{"Read"}, "")
}

// ---------------------------------------------------------------------------
// SendAbort tests
// ---------------------------------------------------------------------------

func TestSendAbort_CancelsActiveRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("abort-me", defaultConfig())
	_ = mgr.SendPrompt("abort-me", "start", nil)

	mgr.SendAbort("abort-me")

	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount == 0 {
		t.Error("expected Cancel to be called")
	}
}

func TestSendAbort_NoActiveRunNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("idle-abort", defaultConfig())

	// Should not panic
	mgr.SendAbort("idle-abort")
}

func TestSendAbort_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Should not panic
	mgr.SendAbort("nonexistent")
}

// ---------------------------------------------------------------------------
// AbortAgent tests
// ---------------------------------------------------------------------------

func TestAbortAgent_KillsByName(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("agent-abort", defaultConfig())

	// Manually inject an agent into the session's registry.
	// Since engineSession is internal, we access via the manager's lock.
	mgr.mu.Lock()
	s := mgr.sessions["agent-abort"]
	s.agentRegistry["worker-1"] = types.AgentHandle{PID: 99999, ParentAgent: ""}
	mgr.mu.Unlock()

	// AbortAgent with subtree=false targets only the named agent.
	// We can't easily verify the kill since PID 99999 doesn't exist,
	// but we verify it doesn't panic.
	mgr.AbortAgent("agent-abort", "worker-1", false)
}

func TestAbortAgent_SubtreeTraversal(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tree", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["tree"]
	s.agentRegistry["root"] = types.AgentHandle{PID: 90001, ParentAgent: ""}
	s.agentRegistry["child1"] = types.AgentHandle{PID: 90002, ParentAgent: "root"}
	s.agentRegistry["child2"] = types.AgentHandle{PID: 90003, ParentAgent: "root"}
	s.agentRegistry["grandchild"] = types.AgentHandle{PID: 90004, ParentAgent: "child1"}
	s.agentRegistry["unrelated"] = types.AgentHandle{PID: 90005, ParentAgent: ""}
	mgr.mu.Unlock()

	// subtree=true on "root" should attempt to kill root, child1, child2, grandchild
	// but NOT unrelated. We can't verify kills on non-existent PIDs, but no panic.
	mgr.AbortAgent("tree", "root", true)
}

func TestAbortAgent_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.AbortAgent("nope", "agent", false)
}

func TestAbortAgent_UnknownAgentNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("s", defaultConfig())

	mgr.AbortAgent("s", "no-such-agent", false)
}

// TestResolveAgentSpec_DirectMatch verifies that an already-registered spec
// resolves without firing the capability_match hook.
func TestResolveAgentSpec_DirectMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("self-hire-direct", defaultConfig())
	defer mgr.StopSession("self-hire-direct")

	mgr.mu.Lock()
	s := mgr.sessions["self-hire-direct"]
	s.agentSpecs["travel-planner"] = types.AgentSpec{
		Name:         "travel-planner",
		Description:  "Plan trips",
		Model:        "claude-sonnet-4-6",
		SystemPrompt: "You plan trips.",
	}
	mgr.mu.Unlock()

	spec, ok := mgr.resolveAgentSpec(s, "self-hire-direct", "travel-planner")
	if !ok {
		t.Fatalf("expected direct match")
	}
	if spec.Description != "Plan trips" {
		t.Errorf("expected description, got %q", spec.Description)
	}
}

// TestResolveAgentSpec_CapabilityMatchPromotion verifies that an unknown
// agent name fires capability_match, the hook handler can call
// RegisterAgentSpec via ctx, and the same call resolves.
func TestResolveAgentSpec_CapabilityMatchPromotion(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("self-hire-promote", defaultConfig())
	defer mgr.StopSession("self-hire-promote")

	mgr.mu.Lock()
	s := mgr.sessions["self-hire-promote"]
	mgr.mu.Unlock()

	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}

	// Inject an in-process host whose SDK handles capability_match by
	// registering the spec via the runtime callback.
	host := extension.NewHost()
	s.extGroup.Add(host)
	host.SDK().On(extension.HookCapabilityMatch, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info, _ := payload.(extension.CapabilityMatchInfo)
		if info.Input == "travel-planner" && ctx.RegisterAgentSpec != nil {
			ctx.RegisterAgentSpec(types.AgentSpec{
				Name:         "travel-planner",
				Description:  "Plan trips (auto-hired)",
				Model:        "claude-sonnet-4-6",
				SystemPrompt: "You plan trips.",
			})
		}
		return nil, nil
	})

	spec, ok := mgr.resolveAgentSpec(s, "self-hire-promote", "travel-planner")
	if !ok {
		t.Fatalf("expected resolution after capability_match promoted spec")
	}
	if spec.Description != "Plan trips (auto-hired)" {
		t.Errorf("unexpected spec description: %q", spec.Description)
	}
}

// TestResolveAgentSpec_StillUnknownAfterHook verifies that resolution fails
// when no handler registers a matching spec.
func TestResolveAgentSpec_StillUnknownAfterHook(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("self-hire-miss", defaultConfig())
	defer mgr.StopSession("self-hire-miss")

	mgr.mu.Lock()
	s := mgr.sessions["self-hire-miss"]
	mgr.mu.Unlock()

	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}

	_, ok := mgr.resolveAgentSpec(s, "self-hire-miss", "ghost")
	if ok {
		t.Errorf("expected miss for unknown agent")
	}
}

// TestAbortAllDescendants_ClearsRegistryAndEmits ensures abortAllDescendants
// kills every agent, clears the registry, and emits a cleared agent_state
// event so the UI panel updates. Triggered when the parent run dies via
// handleRunError or handleRunExit (non-zero) so dispatched children do
// not continue running standalone.
func TestAbortAllDescendants_ClearsRegistryAndEmits(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("reap", defaultConfig())

	var emittedAgentState bool
	var lastEventAgents int = -1
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			emittedAgentState = true
			lastEventAgents = len(ev.Agents)
		}
	})

	mgr.mu.Lock()
	s := mgr.sessions["reap"]
	s.agentRegistry["a"] = types.AgentHandle{PID: 99991, ParentAgent: ""}
	s.agentRegistry["b"] = types.AgentHandle{PID: 99992, ParentAgent: "a"}
	mgr.mu.Unlock()

	mgr.abortAllDescendants("reap", "test")

	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	if got := len(mgr.sessions["reap"].agentRegistry); got != 0 {
		t.Fatalf("expected empty registry after abort, got %d", got)
	}
	if !emittedAgentState {
		t.Fatal("expected engine_agent_state event")
	}
	if lastEventAgents != 0 {
		t.Fatalf("expected zero agents in cleared event, got %d", lastEventAgents)
	}
}

// TestAbortAllDescendants_NoOpWhenEmpty ensures that calling reap on a
// session with no agents is a silent no-op (no event, no panic).
func TestAbortAllDescendants_NoOpWhenEmpty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("empty", defaultConfig())

	var emitted bool
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			emitted = true
		}
	})

	mgr.abortAllDescendants("empty", "test")

	if emitted {
		t.Fatal("did not expect engine_agent_state event when no agents")
	}
}

// TestRespawnDeadExtensions_NoExtensionsNoOp ensures the new respawn flow
// added in Phase F is a silent no-op for sessions with no extensions
// configured. Avoids accidentally emitting status churn on every run exit
// for plain sessions.
func TestRespawnDeadExtensions_NoExtensionsNoOp(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("plain", defaultConfig())

	var anyEvent bool
	mgr.OnEvent(func(_ string, _ types.EngineEvent) {
		anyEvent = true
	})

	mgr.respawnDeadExtensions("plain")

	if anyEvent {
		t.Fatal("expected no events for session without extension group")
	}
}

// TestRespawnDeadExtensions_UnknownSessionNoPanic ensures the helper does
// not panic when invoked for a session that has been torn down already
// (handleRunExit invokes it after the read lock has been released, so
// races are possible).
func TestRespawnDeadExtensions_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.respawnDeadExtensions("never-existed")
}

// ---------------------------------------------------------------------------
// SteerAgent tests
// ---------------------------------------------------------------------------

func TestSteerAgent_WritesToStdin(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("steer", defaultConfig())

	var written string
	mgr.mu.Lock()
	s := mgr.sessions["steer"]
	s.agentRegistry["steerable"] = types.AgentHandle{
		PID:         12345,
		ParentAgent: "",
		StdinWrite: func(msg string) bool {
			written = msg
			return true
		},
	}
	mgr.mu.Unlock()

	mgr.SteerAgent("steer", "steerable", "new direction")

	if written != "new direction" {
		t.Errorf("expected StdinWrite to receive 'new direction', got %q", written)
	}
}

func TestSteerAgent_UnknownAgentNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("steer2", defaultConfig())

	mgr.SteerAgent("steer2", "ghost-agent", "msg")
}

func TestSteerAgent_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SteerAgent("nope", "agent", "msg")
}

func TestSteerAgent_NilStdinWriteNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("steer3", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["steer3"]
	s.agentRegistry["no-stdin"] = types.AgentHandle{PID: 1, StdinWrite: nil}
	mgr.mu.Unlock()

	mgr.SteerAgent("steer3", "no-stdin", "msg")
}

// ---------------------------------------------------------------------------
// IsRunning tests
// ---------------------------------------------------------------------------

func TestIsRunning_TrueDuringRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("running", defaultConfig())
	_ = mgr.SendPrompt("running", "go", nil)

	if !mgr.IsRunning("running") {
		t.Error("expected IsRunning=true during active run")
	}
}

func TestIsRunning_FalseAfterExit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("exited", defaultConfig())
	_ = mgr.SendPrompt("exited", "go", nil)

	// Get request ID
	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs started")
	}

	// Simulate run exit
	code := 0
	mb.emitExit(keys[0], &code, nil, "sess-abc")

	if mgr.IsRunning("exited") {
		t.Error("expected IsRunning=false after exit")
	}
}

func TestIsRunning_FalseWhenIdle(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("idle", defaultConfig())

	if mgr.IsRunning("idle") {
		t.Error("expected IsRunning=false for idle session")
	}
}

func TestIsRunning_FalseForUnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	if mgr.IsRunning("ghost") {
		t.Error("expected IsRunning=false for unknown session")
	}
}
