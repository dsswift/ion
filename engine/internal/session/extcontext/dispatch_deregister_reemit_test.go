package extcontext

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchCountSpyAccessor records EmitDispatchCountStatus calls and all
// emitted EngineEvents so the regression tests can assert the post-deregister
// re-emit fires and carries the correct BackgroundAgents count.
//
// The registry field is set by the test so EmitDispatchCountStatus can
// re-sample the live count from it (mirroring what the real sessionAccessor
// delegates to Manager.emitDispatchCountStatus). This keeps the spy fully
// self-contained without pulling in the full session.Manager.
type dispatchCountSpyAccessor struct {
	child   backend.RunBackend
	rootCtx context.Context

	mu       sync.Mutex
	emitted  []types.EngineEvent
	registry *DispatchRegistry

	// dispatchCountCalls records the reason strings passed to
	// EmitDispatchCountStatus, in order.
	dispatchCountCalls []string

	// dispatchCountAtCall records the live registry count AT THE MOMENT each
	// EmitDispatchCountStatus call fires — this is the "recomputed" count the
	// test asserts on.
	dispatchCountAtCall []int

	// bgCountInStatus records the BackgroundAgents value from each
	// engine_status event emitted by EmitDispatchCountStatus. The final value
	// in this slice is what the client would observe after Deregister.
	bgCountInStatus []int

	// agentStates stores agent state by ID so UpdateAgentStateByID works.
	agentStates map[string]*types.AgentStateUpdate

	// emitDispatchCountInvocations is an atomic counter for race-safe assertions.
	emitDispatchCountInvocations atomic.Int64
}

func (a *dispatchCountSpyAccessor) EmitDispatchCountStatus(reason string) {
	a.emitDispatchCountInvocations.Add(1)

	var count int
	if a.registry != nil {
		count = len(a.registry.ActiveIDs())
	}

	a.mu.Lock()
	a.dispatchCountCalls = append(a.dispatchCountCalls, reason)
	a.dispatchCountAtCall = append(a.dispatchCountAtCall, count)
	a.mu.Unlock()

	// Emit an engine_status with the recomputed count, mirroring the real
	// Manager.emitDispatchCountStatus behaviour.
	ev := types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			Label: "spy-session", State: "idle",
			BackgroundAgents: count,
		},
	}
	a.mu.Lock()
	a.emitted = append(a.emitted, ev)
	a.bgCountInStatus = append(a.bgCountInStatus, count)
	a.mu.Unlock()
}

func (a *dispatchCountSpyAccessor) lastBgCountInStatus() (int, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.bgCountInStatus) == 0 {
		return 0, false
	}
	return a.bgCountInStatus[len(a.bgCountInStatus)-1], true
}

func (a *dispatchCountSpyAccessor) dispatchCountCallCount() int {
	return int(a.emitDispatchCountInvocations.Load())
}

// BumpParentProgress is a no-op for this spy; the test only cares about
// EmitDispatchCountStatus.
func (a *dispatchCountSpyAccessor) BumpParentProgress() {}

func (a *dispatchCountSpyAccessor) NewChildBackend() backend.RunBackend { return a.child }
func (a *dispatchCountSpyAccessor) AllocatePlanFilePath() string        { return "/tmp/.ion/plans/plan.md" }
func (a *dispatchCountSpyAccessor) RootContext() context.Context {
	if a.rootCtx != nil {
		return a.rootCtx
	}
	return context.Background()
}

func (a *dispatchCountSpyAccessor) SessionKey() string       { return "spy-session" }
func (a *dispatchCountSpyAccessor) ExtensionName() string    { return "" }
func (a *dispatchCountSpyAccessor) ExtensionVersion() string { return "" }
func (a *dispatchCountSpyAccessor) ConversationID() string   { return "" }
func (a *dispatchCountSpyAccessor) WorkingDirectory() string { return "/tmp" }
func (a *dispatchCountSpyAccessor) Emit(ev types.EngineEvent) {
	a.mu.Lock()
	a.emitted = append(a.emitted, ev)
	a.mu.Unlock()
}
func (a *dispatchCountSpyAccessor) SendAbort()                               {}
func (a *dispatchCountSpyAccessor) SendPrompt(_, _ string, _ []string) error { return nil }
func (a *dispatchCountSpyAccessor) SteerSelfMainLoop(_ string) bool          { return false }
func (a *dispatchCountSpyAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *dispatchCountSpyAccessor) SuppressTool(_ string)                          {}
func (a *dispatchCountSpyAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (a *dispatchCountSpyAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (a *dispatchCountSpyAccessor) DeregisterAgent(_ string)                       {}
func (a *dispatchCountSpyAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (a *dispatchCountSpyAccessor) DeregisterAgentSpec(_ string)                   {}
func (a *dispatchCountSpyAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *dispatchCountSpyAccessor) LookupExtDisplayName(_ string) string     { return "" }
func (a *dispatchCountSpyAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *dispatchCountSpyAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *dispatchCountSpyAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *dispatchCountSpyAccessor) EngineConfig() *types.EngineRuntimeConfig { return nil }
func (a *dispatchCountSpyAccessor) ClaudeCompat() bool { return false }
func (a *dispatchCountSpyAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }
func (a *dispatchCountSpyAccessor) ResolveTier(_ string) string              { return "" }
func (a *dispatchCountSpyAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *dispatchCountSpyAccessor) McpConnections() []*mcp.Connection                      { return nil }
func (a *dispatchCountSpyAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *dispatchCountSpyAccessor) GetSessionMemory() string                               { return "" }
func (a *dispatchCountSpyAccessor) SetSessionMemory(_ string)                              {}
func (a *dispatchCountSpyAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *dispatchCountSpyAccessor) SetPlanMode(_ bool, _ string)     {}
func (a *dispatchCountSpyAccessor) GetPlanModeState() (bool, string) { return false, "" }
func (a *dispatchCountSpyAccessor) AppendOrUpdateAgentState(s types.AgentStateUpdate) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.agentStates == nil {
		a.agentStates = map[string]*types.AgentStateUpdate{}
	}
	cp := s
	a.agentStates[s.ID] = &cp
	return s.ID
}
func (a *dispatchCountSpyAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if st, ok := a.agentStates[id]; ok {
		updater(st)
	}
}
func (a *dispatchCountSpyAccessor) EmitAgentSnapshot(_ string)                                     {}
func (a *dispatchCountSpyAccessor) ResourceBroker() *resource.Broker                               { return nil }
func (a *dispatchCountSpyAccessor) GlobalResourceBroker() *resource.Broker                         { return nil }
func (a *dispatchCountSpyAccessor) BroadcastNotification(_ types.NotifyOpts)                       {}
func (a *dispatchCountSpyAccessor) BroadcastIntercept(_ extension.InterceptOpts)                   {}
func (a *dispatchCountSpyAccessor) ListAllSessions() []extension.SessionListEntry                  { return nil }
func (a *dispatchCountSpyAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}
func (a *dispatchCountSpyAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *dispatchCountSpyAccessor) RunOnceComplete(_ string, _ bool)              {}
func (a *dispatchCountSpyAccessor) Telemetry() *telemetry.Collector { return nil }

// TestDeregisterReEmitsDispatchCount is the primary regression test for the
// nested-dispatch completion race (Bug 1).
//
// Root cause: handleRunExit samples bgCount from
// dispatchRegistry.ActiveIDs() BEFORE the child goroutine calls
// registry.Deregister(agentID). After Deregister, nothing re-emits
// engine_status, so the stale BackgroundAgents:1 is the last value the
// client sees — the parent tab stays "waiting on background agent" forever.
//
// The fix: dispatch_agent.go calls sa.EmitDispatchCountStatus("dispatch_deregister")
// immediately after registry.Deregister(agentID) so the post-Deregister count
// (0 when the last child finishes) reaches the client.
//
// Red-then-green: revert the sa.EmitDispatchCountStatus call in dispatch_agent.go
// (the line immediately after registry.Deregister) and re-run. This test goes
// red because dispatchCountCallCount() stays 0 and lastBgCountInStatus returns
// 1 (the stale value stamped at run-exit).
func TestDeregisterReEmitsDispatchCount(t *testing.T) {
	registry := NewDispatchRegistry()

	child := &drippingChildBackend{numEvents: 2}
	acc := &dispatchCountSpyAccessor{
		child:    child,
		registry: registry,
	}

	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name: "count-test-agent",
		Task: "do work",
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}
	if result == nil {
		t.Fatal("dispatch returned nil result")
	}

	// EmitDispatchCountStatus must have been called at least once (the call
	// immediately after registry.Deregister). On the pre-fix code this count
	// is 0 because EmitDispatchCountStatus was never wired.
	if acc.dispatchCountCallCount() < 1 {
		t.Fatalf("EmitDispatchCountStatus was not called after Deregister (count=%d); "+
			"the re-emit wiring is missing or regressed", acc.dispatchCountCallCount())
	}

	// The count sampled AT the time EmitDispatchCountStatus fired must be 0:
	// Deregister has already run, so ActiveIDs() should be empty.
	// A count of 1 here means the call fires BEFORE Deregister (ordering bug).
	acc.mu.Lock()
	countAtCall := acc.dispatchCountAtCall[len(acc.dispatchCountAtCall)-1]
	acc.mu.Unlock()
	if countAtCall != 0 {
		t.Errorf("EmitDispatchCountStatus sampled bgCount=%d after Deregister, want 0; "+
			"call fires before Deregister (ordering bug)", countAtCall)
	}
}

// TestDeregisterFinalStatusCarriesZeroBgCount is the engine_status regression
// test for the nested-dispatch completion race.
//
// It verifies that the LAST engine_status event emitted for a foreground
// dispatch that completed carries BackgroundAgents==0. On unfixed code,
// handleRunExit emits BackgroundAgents:1 (sampled before Deregister) and
// nothing corrects it, so the client-visible last value is 1 forever.
//
// Red-then-green: revert the sa.EmitDispatchCountStatus call in dispatch_agent.go
// and re-run. lastBgCountInStatus will be absent (no EmitDispatchCountStatus
// emits any engine_status) and the test fails because the count is not 0 in
// the final spy-emitted status.
func TestDeregisterFinalStatusCarriesZeroBgCount(t *testing.T) {
	registry := NewDispatchRegistry()

	child := &drippingChildBackend{numEvents: 2}
	acc := &dispatchCountSpyAccessor{
		child:    child,
		registry: registry,
	}

	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{
		Name: "status-count-test-agent",
		Task: "check bg count in status",
	})

	// Give any background goroutines a brief moment (foreground dispatch is
	// synchronous, but belt-and-suspenders for the dripping backend's goroutine).
	time.Sleep(20 * time.Millisecond)

	count, ok := acc.lastBgCountInStatus()
	if !ok {
		t.Fatal("EmitDispatchCountStatus emitted no engine_status; re-emit wiring is missing")
	}
	if count != 0 {
		t.Errorf("final engine_status BackgroundAgents=%d, want 0; "+
			"the stale bgCount from handleRunExit was not corrected by Deregister re-emit", count)
	}
}
