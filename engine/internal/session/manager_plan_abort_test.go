package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestSetPlanMode_Enable(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("plan", defaultConfig())

	mgr.SetPlanMode("plan", true, []string{"Read", "Grep"}, "", "")

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

	mgr.SetPlanMode("plan2", true, []string{"Read"}, "", "")
	mgr.SetPlanMode("plan2", false, nil, "", "")

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
	mgr.SetPlanMode("ghost", true, []string{"Read"}, "", "")
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

// TestSendAbort_DropsQueuedPrompts pins the discard semantic: a prompt queued
// behind the in-flight run (because the session was busy) must be dropped when
// the user presses Stop. Without this, SendAbort would leave the queue intact
// and handleRunExit would later resurrect work the user explicitly abandoned.
func TestSendAbort_DropsQueuedPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("abort-queue", defaultConfig())

	// First prompt starts a run and sets requestID (session now busy).
	_ = mgr.SendPrompt("abort-queue", "first", nil)
	// Second prompt lands in promptQueue because requestID is non-empty.
	_ = mgr.SendPrompt("abort-queue", "queued", nil)

	mgr.mu.RLock()
	queuedBefore := len(mgr.sessions["abort-queue"].promptQueue)
	mgr.mu.RUnlock()
	if queuedBefore != 1 {
		t.Fatalf("precondition: expected 1 queued prompt before abort, got %d", queuedBefore)
	}

	mgr.SendAbort("abort-queue")

	mgr.mu.RLock()
	queuedAfter := len(mgr.sessions["abort-queue"].promptQueue)
	mgr.mu.RUnlock()
	if queuedAfter != 0 {
		t.Errorf("expected empty promptQueue after SendAbort, got %d", queuedAfter)
	}
}

// TestSendAbort_PostAbortPromptDispatchedOnRunExit is the direct regression
// test for the reported bug: a prompt typed right after Stop (while the
// cancelled run is still unwinding, so requestID is still set) must be held and
// dispatched once the cancelled run exits — not silently ignored. The discard
// in SendAbort empties the queue first, so the only entry present at run-exit
// time is the post-abort prompt, which the existing handleRunExit drain
// dispatches as a fresh run.
func TestSendAbort_PostAbortPromptDispatchedOnRunExit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("abort-hold", defaultConfig())

	// First prompt starts the run that the user will Stop.
	_ = mgr.SendPrompt("abort-hold", "first", nil)
	mgr.mu.RLock()
	runID := mgr.sessions["abort-hold"].requestID
	mgr.mu.RUnlock()
	if runID == "" {
		t.Fatal("precondition: expected an active requestID after first prompt")
	}

	// User presses Stop. requestID is intentionally left for handleRunExit;
	// the cancelled run has not unwound yet.
	mgr.SendAbort("abort-hold")

	// User types a new prompt during the abort window. requestID is still
	// set, so this queues onto the (now-empty) queue.
	_ = mgr.SendPrompt("abort-hold", "post-stop text", nil)
	mgr.mu.RLock()
	queued := len(mgr.sessions["abort-hold"].promptQueue)
	mgr.mu.RUnlock()
	if queued != 1 {
		t.Fatalf("expected post-abort prompt to be queued (1), got %d", queued)
	}

	// The cancelled run finally exits (signal "cancelled"). handleRunExit
	// clears requestID and drains the queue, dispatching the held prompt on
	// a goroutine.
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	// Poll for the second StartRun (no fixed sleep — bounded wait).
	deadline := time.Now().Add(2 * time.Second)
	var ordered []string
	for time.Now().Before(deadline) {
		ordered = mb.startedInOrder()
		if len(ordered) >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(ordered) < 2 {
		t.Fatalf("expected post-abort prompt to be dispatched as a second run, got %d run(s)", len(ordered))
	}
	opts, _ := mb.getStarted(ordered[1])
	if opts.Prompt != "post-stop text" {
		t.Errorf("expected dispatched prompt %q, got %q", "post-stop text", opts.Prompt)
	}
}

// TestSendAbort_NoQueuedPrompt_RunExitDispatchesNothing pins the "stop means
// stop" path: when the user aborts with nothing queued and types no follow-up,
// the cancelled run's exit must dispatch nothing. This guards against a
// regression where discarded or phantom queue entries get auto-dispatched.
func TestSendAbort_NoQueuedPrompt_RunExitDispatchesNothing(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("abort-nothing", defaultConfig())

	_ = mgr.SendPrompt("abort-nothing", "first", nil)
	mgr.mu.RLock()
	runID := mgr.sessions["abort-nothing"].requestID
	mgr.mu.RUnlock()

	mgr.SendAbort("abort-nothing")
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	// Bounded settle window: if a spurious dispatch were going to happen it
	// would happen on the drain goroutine shortly after emitExit.
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(mb.startedInOrder()) > 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := len(mb.startedInOrder()); got != 1 {
		t.Errorf("expected exactly 1 run (no resurrection after abort), got %d", got)
	}
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// TestResolveAgentSpec_DirectMatch verifies that an already-registered spec
// resolves without firing the capability_match hook.
func TestResolveAgentSpec_DirectMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("self-hire-direct", defaultConfig())
	defer mgr.StopSession("self-hire-direct")

	mgr.mu.Lock()
	s := mgr.sessions["self-hire-direct"]
	s.agents.RegisterSpec(types.AgentSpec{
		Name:         "travel-planner",
		Description:  "Plan trips",
		Model:        "claude-sonnet-4-6",
		SystemPrompt: "You plan trips.",
	})
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
	lastEventAgents := -1
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			emittedAgentState = true
			lastEventAgents = len(ev.Agents)
		}
	})

	mgr.mu.Lock()
	s := mgr.sessions["reap"]
	s.agents.RegisterHandle("a", types.AgentHandle{PID: 99991, ParentAgent: ""})
	s.agents.RegisterHandle("b", types.AgentHandle{PID: 99992, ParentAgent: "a"})
	mgr.mu.Unlock()

	mgr.abortAllDescendants("reap", "test")

	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	if got := mgr.sessions["reap"].agents.HandleCount(); got != 0 {
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
	s.agents.RegisterHandle("steerable", types.AgentHandle{
		PID:         12345,
		ParentAgent: "",
		StdinWrite: func(msg string) bool {
			written = msg
			return true
		},
	})
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
	s.agents.RegisterHandle("no-stdin", types.AgentHandle{PID: 1, StdinWrite: nil})
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

// ---------------------------------------------------------------------------
// Plan mode reentry tests
// ---------------------------------------------------------------------------

func TestMarkPlanModeExited_SetsFlag(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("reentry", defaultConfig())

	mgr.MarkPlanModeExited("reentry")

	mgr.mu.RLock()
	s := mgr.sessions["reentry"]
	got := s.hasExitedPlanMode
	mgr.mu.RUnlock()

	if !got {
		t.Error("expected hasExitedPlanMode=true after MarkPlanModeExited")
	}
}

func TestMarkPlanModeExited_UnknownSessionNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Should not panic
	mgr.MarkPlanModeExited("ghost")
}

func TestSetPlanMode_PreservesPlanFilePathAfterExit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("preserve", defaultConfig())

	// Enable plan mode and send a prompt to generate a plan file path
	mgr.SetPlanMode("preserve", true, []string{"Read"}, "test", "")
	_ = mgr.SendPrompt("preserve", "plan it", nil)

	// Capture the plan file path
	mgr.mu.RLock()
	s := mgr.sessions["preserve"]
	planFile := s.planFilePath
	mgr.mu.RUnlock()

	if planFile == "" {
		t.Fatal("expected planFilePath to be set after SendPrompt in plan mode")
	}

	// Mark as exited (simulates ExitPlanMode firing)
	mgr.MarkPlanModeExited("preserve")

	// Disable plan mode — planFilePath should be preserved because hasExitedPlanMode is true
	mgr.SetPlanMode("preserve", false, nil, "test", "")

	mgr.mu.RLock()
	s = mgr.sessions["preserve"]
	afterDisable := s.planFilePath
	mgr.mu.RUnlock()

	if afterDisable != planFile {
		t.Errorf("expected planFilePath to be preserved after disable with hasExitedPlanMode, got %q (was %q)", afterDisable, planFile)
	}
}

// TestSetPlanMode_PreservesPlanFilePathOnManualDisable verifies that disabling
// plan mode via a manual toggle (no MarkPlanModeExited call) preserves the
// planFilePath and sets hasExitedPlanMode=true. This is the key regression
// test for the bug where toggling plan mode off via the dropdown would orphan
// the plan file and cause a new hash to be allocated on re-entry.
func TestSetPlanMode_PreservesPlanFilePathOnManualDisable(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("manual-disable", defaultConfig())

	// Enable plan mode and send a prompt to generate a plan file path
	mgr.SetPlanMode("manual-disable", true, []string{"Read"}, "test", "")
	_ = mgr.SendPrompt("manual-disable", "plan it", nil)

	// Capture the plan file path
	mgr.mu.RLock()
	s := mgr.sessions["manual-disable"]
	planFile := s.planFilePath
	mgr.mu.RUnlock()

	if planFile == "" {
		t.Fatal("expected planFilePath to be set after SendPrompt in plan mode")
	}

	// Disable plan mode WITHOUT calling MarkPlanModeExited (simulates dropdown toggle).
	// planFilePath MUST be preserved, and hasExitedPlanMode MUST be set true.
	mgr.SetPlanMode("manual-disable", false, nil, "ui_dropdown", "")

	mgr.mu.RLock()
	s = mgr.sessions["manual-disable"]
	afterPath := s.planFilePath
	afterExited := s.hasExitedPlanMode
	mgr.mu.RUnlock()

	if afterPath != planFile {
		t.Errorf("expected planFilePath to be preserved after manual disable, got %q (was %q)", afterPath, planFile)
	}
	if !afterExited {
		t.Error("expected hasExitedPlanMode=true after manual disable with existing plan file")
	}
}

func TestPlanModeReentry_SetOnRunOptions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("reentry-opts", defaultConfig())

	// Enable plan mode and send first prompt to generate plan file path
	mgr.SetPlanMode("reentry-opts", true, []string{"Read"}, "test", "")
	_ = mgr.SendPrompt("reentry-opts", "plan it", nil)

	// Mark as exited and disable plan mode
	mgr.MarkPlanModeExited("reentry-opts")
	mgr.SetPlanMode("reentry-opts", false, nil, "test", "")

	// Simulate run exit so requestID is cleared
	ordered := mb.startedInOrder()
	code := 0
	mb.emitExit(ordered[0], &code, nil, "sess-abc")

	// Re-enable plan mode — should be detected as reentry
	mgr.SetPlanMode("reentry-opts", true, []string{"Read"}, "test", "")
	_ = mgr.SendPrompt("reentry-opts", "add a deliverable", nil)

	allOrdered := mb.startedInOrder()
	if len(allOrdered) < 2 {
		t.Fatal("expected 2 started runs")
	}
	opts, _ := mb.getStarted(allOrdered[1])
	if !opts.PlanModeReentry {
		t.Error("expected PlanModeReentry=true on second plan mode run")
	}
}

// TestSetPlanMode_ReentryAfterManualToggle is the direct regression test for the
// original bug: the user toggles plan mode off via the dropdown (no ExitPlanMode
// call) and then re-enters. The engine must reuse the same planFilePath and flag
// the run as a reentry so the LLM gets the reentry guidance prompt.
func TestSetPlanMode_ReentryAfterManualToggle(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("manual-reentry", defaultConfig())

	// Enter plan mode, send a prompt to allocate a plan hash.
	mgr.SetPlanMode("manual-reentry", true, []string{"Read"}, "test", "")
	_ = mgr.SendPrompt("manual-reentry", "plan it", nil)

	mgr.mu.RLock()
	s := mgr.sessions["manual-reentry"]
	firstPlanFile := s.planFilePath
	mgr.mu.RUnlock()

	if firstPlanFile == "" {
		t.Fatal("expected planFilePath to be set after first SendPrompt")
	}

	// Simulate run exit so requestID is cleared.
	ordered := mb.startedInOrder()
	code := 0
	mb.emitExit(ordered[0], &code, nil, "sess-1")

	// User toggles plan mode OFF via dropdown — no MarkPlanModeExited call.
	mgr.SetPlanMode("manual-reentry", false, nil, "ui_dropdown", "")

	// User toggles plan mode ON again via dropdown.
	mgr.SetPlanMode("manual-reentry", true, []string{"Read"}, "ui_dropdown", "")
	_ = mgr.SendPrompt("manual-reentry", "amend the plan", nil)

	// The second run must see the same planFilePath and PlanModeReentry=true.
	allOrdered := mb.startedInOrder()
	if len(allOrdered) < 2 {
		t.Fatal("expected 2 started runs")
	}
	opts, _ := mb.getStarted(allOrdered[1])

	if opts.PlanFilePath != firstPlanFile {
		t.Errorf("expected reused planFilePath=%q on re-entry, got %q", firstPlanFile, opts.PlanFilePath)
	}
	if !opts.PlanModeReentry {
		t.Error("expected PlanModeReentry=true on second plan mode run after manual toggle")
	}
}
