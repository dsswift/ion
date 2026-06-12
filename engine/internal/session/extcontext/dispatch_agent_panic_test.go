package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
)

// panicTestAccessor is a SessionAccessor that records the calls
// recoverBackgroundDispatchPanic makes against it. Unlike the more
// minimal agentDiscoveryTestAccessor, this one captures
// UpdateAgentStateByID closures and EmitAgentSnapshot reasons so the
// test can assert the synthesized terminal transition happens.
type panicTestAccessor struct {
	mu                    sync.Mutex
	extGroup              *extension.ExtensionGroup
	updatedAgentID        string
	updaterCalled         bool
	finalState            types.AgentStateUpdate
	snapshotReasons       []string
	emittedEvents         []types.EngineEvent
}

func (p *panicTestAccessor) SessionKey() string       { return "panic-test-session" }
func (p *panicTestAccessor) ConversationID() string   { return "" }
func (p *panicTestAccessor) WorkingDirectory() string { return "/tmp" }
func (p *panicTestAccessor) Emit(ev types.EngineEvent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.emittedEvents = append(p.emittedEvents, ev)
}
func (p *panicTestAccessor) SendAbort() {}
func (p *panicTestAccessor) SendPrompt(_, _ string) error { return nil }
func (p *panicTestAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (p *panicTestAccessor) SuppressTool(_ string)                          {}
func (p *panicTestAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (p *panicTestAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (p *panicTestAccessor) DeregisterAgent(_ string)                       {}
func (p *panicTestAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (p *panicTestAccessor) DeregisterAgentSpec(_ string)                   {}
func (p *panicTestAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (p *panicTestAccessor) LookupExtDisplayName(_ string) string        { return "" }
func (p *panicTestAccessor) ExtGroup() *extension.ExtensionGroup         { return p.extGroup }
func (p *panicTestAccessor) ExtConfig() *extension.ExtensionConfig       { return nil }
func (p *panicTestAccessor) ProcRegistry() *extension.ProcessRegistry    { return nil }
func (p *panicTestAccessor) NewChildBackend() backend.RunBackend         { return nil }
func (p *panicTestAccessor) EngineConfig() *types.EngineRuntimeConfig    { return nil }
func (p *panicTestAccessor) ResolveTier(_ string) string                 { return "" }
func (p *panicTestAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (p *panicTestAccessor) McpConnections() []*mcp.Connection             { return nil }
func (p *panicTestAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (p *panicTestAccessor) GetSessionMemory() string                              { return "" }
func (p *panicTestAccessor) SetSessionMemory(_ string)                             {}
func (p *panicTestAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (p *panicTestAccessor) SetPlanMode(_ bool, _ string)     {}
func (p *panicTestAccessor) GetPlanModeState() (bool, string) { return false, "" }
func (p *panicTestAccessor) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string {
	return ""
}
func (p *panicTestAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.updatedAgentID = id
	p.updaterCalled = true
	// Drive the closure against a fresh state struct so the test can
	// inspect what runChild's recovery branch would have written.
	state := types.AgentStateUpdate{}
	updater(&state)
	p.finalState = state
}
func (p *panicTestAccessor) EmitAgentSnapshot(reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.snapshotReasons = append(p.snapshotReasons, reason)
}
func (p *panicTestAccessor) ResourceBroker() *resource.Broker        { return nil }
func (p *panicTestAccessor) GlobalResourceBroker() *resource.Broker  { return nil }
func (p *panicTestAccessor) BroadcastNotification(_ types.NotifyOpts) {}
func (p *panicTestAccessor) BroadcastIntercept(_ extension.InterceptOpts) {}
func (p *panicTestAccessor) ListAllSessions() []extension.SessionListEntry { return nil }
func (p *panicTestAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}
func (p *panicTestAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (p *panicTestAccessor) RunOnceComplete(_ string, _ bool)              {}

// TestRecoverBackgroundDispatchPanic_SynthesizesTerminalState is the
// invariant test for the silent-wedge defect. A background dispatch
// that panics inside runChild today leaves the agent in indefinite
// "running" status — no terminal transition, no agent_end, no
// dispatch-end telemetry, no registry deregister. The original
// incident (conversation 1780874102870-12aee36b1e8d) was the textbook
// example: the engine log showed two background dispatches that
// stopped emitting at the same instant with no terminal log line.
//
// recoverBackgroundDispatchPanic must produce the same five-step
// terminal sequence that runChild's normal-error branch does:
//
//   1. utils.Error log with the panic message and stack trace
//   2. UpdateAgentStateByID transitions the agent to "error" with
//      a lastWork message that surfaces the panic in the agent panel
//   3. EmitAgentSnapshot fires so consumers see the terminal status
//   4. agent_end fires on the parent extension group (skipped here
//      because the test accessor has no real ExtGroup; the in-tree
//      code path is exercised when ExtGroup is non-nil)
//   5. engine_dispatch_end fires on the parent session
//   6. Registry deregisters the agent name
//
// This test focuses on the SessionAccessor-observable transitions
// (steps 2, 3, 5) plus the registry deregister (step 6). The
// stack-trace logging in step 1 is not assertable from the test
// harness (utils.Error writes to the engine log on disk) but the code
// path runs as a side effect of the call.
func TestRecoverBackgroundDispatchPanic_SynthesizesTerminalState(t *testing.T) {
	sa := &panicTestAccessor{}
	registry := NewDispatchRegistry()

	// Register the agent first so deregister has something to remove.
	// In production this happens at the top of the background dispatch
	// branch before the goroutine is launched.
	registry.Register("test-agent",
		func() {},
		nil, // child backend not exercised on the panic path
		"panic-test-session",
	)
	if _, ok := registry.ActiveNames()["test-agent"]; !ok {
		t.Fatal("precondition: registry should have the test agent registered")
	}

	opts := extension.DispatchAgentOpts{
		Name: "test-agent",
		Task: "exercise panic recovery",
	}

	// Drive the recovery helper directly. In production this is called
	// from a deferred recover() block in the goroutine; calling it
	// directly here lets the test assert the synthesized transitions
	// without the timing fragility of provoking a real panic from a
	// mock provider.
	recoverBackgroundDispatchPanic(
		sa,
		registry,
		opts,
		"panic-test-session",
		"agent-id-xyz",
		"test-agent",
		"synthetic panic value for test",
	)

	sa.mu.Lock()
	defer sa.mu.Unlock()

	// Assertion 1: agent state transitioned to "error" with a
	// recognizable lastWork.
	if !sa.updaterCalled {
		t.Fatal("UpdateAgentStateByID was not called — agent stays in 'running' indefinitely")
	}
	if sa.updatedAgentID != "agent-id-xyz" {
		t.Errorf("UpdateAgentStateByID called with id=%q, want %q", sa.updatedAgentID, "agent-id-xyz")
	}
	if sa.finalState.Status != "error" {
		t.Errorf("finalState.Status = %q, want %q", sa.finalState.Status, "error")
	}
	if sa.finalState.Metadata == nil {
		t.Fatal("finalState.Metadata is nil — recovery must populate it so consumers can render the panic message")
	}
	lastWork, _ := sa.finalState.Metadata["lastWork"].(string)
	if lastWork == "" {
		t.Fatal("finalState.Metadata[lastWork] is empty — operator has no postmortem context")
	}

	// Assertion 2: a snapshot was emitted so consumers see the terminal
	// transition, with the dedicated "dispatch_panic" reason so a log
	// reader can distinguish recovered panics from normal completions.
	var sawPanicSnapshot bool
	for _, r := range sa.snapshotReasons {
		if r == "dispatch_panic" {
			sawPanicSnapshot = true
			break
		}
	}
	if !sawPanicSnapshot {
		t.Errorf("expected EmitAgentSnapshot(\"dispatch_panic\"), reasons=%v", sa.snapshotReasons)
	}

	// Assertion 3: engine_dispatch_end was emitted on the parent
	// session with exit code 1. Consumers (cost trackers, agent panel
	// deregistration) get the same end-of-life signal they get for a
	// normal termination.
	var sawDispatchEnd bool
	for _, ev := range sa.emittedEvents {
		if ev.Type == "engine_dispatch_end" && ev.DispatchAgent == "test-agent" && ev.DispatchExitCode == 1 {
			sawDispatchEnd = true
			break
		}
	}
	if !sawDispatchEnd {
		t.Errorf("expected engine_dispatch_end emit with exit code 1, got events=%v", sa.emittedEvents)
	}

	// Assertion 4: the registry deregistered the agent. Without this
	// the parent session's backgroundAgents counter on engine_status
	// stays positive forever — exactly the "stuck tab" visual symptom
	// from the original incident.
	if _, stillActive := registry.ActiveNames()["test-agent"]; stillActive {
		t.Error("registry still has the agent after recovery — backgroundAgents counter will stay positive")
	}
}

// TestBackgroundDispatchAgentEndAlwaysFires is the table-driven
// invariant the silent-wedge fix introduces: every background
// dispatch must reach a terminal status. The plan calls out the
// terminal paths individually:
//
//   - normal completion: runChild reaches end_turn, status = "done"
//   - child error: runChild's childErr != nil branch, status = "error"
//   - recall: ctx cancelled via registry.Recall, status = "cancelled"
//   - panic: deferred recover() catches it, status = "error"
//   - run stall: watchdog cancels ctx, which surfaces in runChild's
//     childErr/ctx branch and falls through to the error or cancelled
//     path depending on timing
//
// The first three are covered by existing runChild behavior (the test
// would have to spin up a full mock provider stack to exercise them
// end-to-end). The panic path is the new branch this fix adds and is
// covered by TestRecoverBackgroundDispatchPanic_SynthesizesTerminalState
// above. The run-stall path is covered by the watchdog tests in
// internal/backend/runloop_watchdog_test.go.
//
// This test pins the *invariant* — that the recovery helper, when
// invoked with each kind of panic value (string, error, generic),
// always produces a non-empty terminal state. It is a guard against
// future refactors that might accidentally short-circuit the recovery
// for a panic value the formatter doesn't recognize.
func TestBackgroundDispatchAgentEndAlwaysFires(t *testing.T) {
	cases := []struct {
		name       string
		panicValue interface{}
	}{
		{"string panic", "boom"},
		{"error panic", &fakePanicErr{msg: "boom"}},
		{"int panic", 42},
		{"nil-ish panic", struct{}{}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sa := &panicTestAccessor{}
			registry := NewDispatchRegistry()
			registry.Register("agent-"+tc.name, func() {}, nil, "k")

			recoverBackgroundDispatchPanic(
				sa, registry,
				extension.DispatchAgentOpts{Name: "agent-" + tc.name, Task: "t"},
				"k", "id", "agent-"+tc.name, tc.panicValue,
			)

			sa.mu.Lock()
			defer sa.mu.Unlock()
			if sa.finalState.Status != "error" {
				t.Errorf("status = %q, want %q", sa.finalState.Status, "error")
			}
			if _, stillActive := registry.ActiveNames()["agent-"+tc.name]; stillActive {
				t.Error("registry retained the agent — invariant violated")
			}
		})
	}
}

type fakePanicErr struct{ msg string }

func (e *fakePanicErr) Error() string { return e.msg }
