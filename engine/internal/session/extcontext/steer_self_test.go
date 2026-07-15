package extcontext

import (
	"context"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// steerSelfAccessor records SteerSelfMainLoop and SendPrompt calls so the
// SteerSelf wiring can be asserted. mainLoopLive controls whether the
// depth-0 main-loop steer reports a live run.
type steerSelfAccessor struct {
	mu sync.Mutex

	mainLoopLive bool

	steerMainLoopCalls []string
	sendPromptCalls    []string
}

func (a *steerSelfAccessor) SessionKey() string          { return "steer-self-test" }
func (a *steerSelfAccessor) ExtensionName() string    { return "" }
func (a *steerSelfAccessor) ExtensionVersion() string { return "" }
func (a *steerSelfAccessor) ConversationID() string      { return "conv-steer" }
func (a *steerSelfAccessor) WorkingDirectory() string    { return "/tmp" }
func (a *steerSelfAccessor) Emit(ev types.EngineEvent)   {}
func (a *steerSelfAccessor) SendAbort()                  {}
func (a *steerSelfAccessor) RootContext() context.Context { return context.Background() }

func (a *steerSelfAccessor) SendPrompt(text string, model string, bash []string) error {
	a.mu.Lock()
	a.sendPromptCalls = append(a.sendPromptCalls, text)
	a.mu.Unlock()
	return nil
}

func (a *steerSelfAccessor) SteerSelfMainLoop(message string) bool {
	a.mu.Lock()
	a.steerMainLoopCalls = append(a.steerMainLoopCalls, message)
	live := a.mainLoopLive
	a.mu.Unlock()
	return live
}

func (a *steerSelfAccessor) Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *steerSelfAccessor) SuppressTool(name string)                            {}
func (a *steerSelfAccessor) CacheExtAgentStates(agents []types.AgentStateUpdate) {}
func (a *steerSelfAccessor) RegisterAgent(name string, handle types.AgentHandle) {}
func (a *steerSelfAccessor) DeregisterAgent(name string)                         {}
func (a *steerSelfAccessor) RegisterAgentSpec(spec types.AgentSpec)              {}
func (a *steerSelfAccessor) DeregisterAgentSpec(name string)                     {}
func (a *steerSelfAccessor) LookupAgentSpec(name string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *steerSelfAccessor) LookupExtDisplayName(name string) string  { return "" }
func (a *steerSelfAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *steerSelfAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *steerSelfAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *steerSelfAccessor) NewChildBackend() backend.RunBackend      { return backend.NewApiBackend() }
func (a *steerSelfAccessor) AllocatePlanFilePath() string             { return "/tmp/.ion/plans/plan.md" }
func (a *steerSelfAccessor) BumpParentProgress()                      {}
func (a *steerSelfAccessor) EmitDispatchCountStatus(_ string)         {}
func (a *steerSelfAccessor) EngineConfig() *types.EngineRuntimeConfig { return nil }
func (a *steerSelfAccessor) ClaudeCompat() bool { return false }
func (a *steerSelfAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }
func (a *steerSelfAccessor) ResolveTier(name string) string           { return name }
func (a *steerSelfAccessor) PermissionCheck(toolName string, input map[string]interface{}) (string, string) {
	return "", ""
}
func (a *steerSelfAccessor) McpConnections() []*mcp.Connection { return nil }
func (a *steerSelfAccessor) SearchHistory(query string, maxResults int) []extension.HistoryMatch {
	return nil
}
func (a *steerSelfAccessor) GetSessionMemory() string        { return "" }
func (a *steerSelfAccessor) SetSessionMemory(content string) {}
func (a *steerSelfAccessor) TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *steerSelfAccessor) SetPlanMode(enabled bool, source string) {}
func (a *steerSelfAccessor) GetPlanModeState() (bool, string)        { return false, "" }
func (a *steerSelfAccessor) AppendOrUpdateAgentState(state types.AgentStateUpdate) string {
	return state.ID
}
func (a *steerSelfAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {}
func (a *steerSelfAccessor) EmitAgentSnapshot(reason string)                                       {}
func (a *steerSelfAccessor) ResourceBroker() *resource.Broker                                      { return nil }
func (a *steerSelfAccessor) GlobalResourceBroker() *resource.Broker                                { return nil }
func (a *steerSelfAccessor) BroadcastNotification(opts types.NotifyOpts)                           {}
func (a *steerSelfAccessor) BroadcastIntercept(opts extension.InterceptOpts)                       {}
func (a *steerSelfAccessor) ListAllSessions() []extension.SessionListEntry                         { return nil }
func (a *steerSelfAccessor) SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error {
	return nil
}

func (a *steerSelfAccessor) FireSchedule(_, _ string) error { return nil }
func (a *steerSelfAccessor) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (a *steerSelfAccessor) RunOnceCheck(operationID string, debounceMs int64) (bool, string) {
	return false, ""
}
func (a *steerSelfAccessor) RunOnceComplete(operationID string, failed bool) {}
func (a *steerSelfAccessor) Telemetry() *telemetry.Collector { return nil }

func (a *steerSelfAccessor) snapshot() (steerCalls, sendCalls []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.steerMainLoopCalls...), append([]string(nil), a.sendPromptCalls...)
}

// TestSteerSelf_Depth0_LiveRun_Steers verifies that at depth 0 with a live
// main run, SteerSelf injects via the main-loop steer and reports "steered"
// WITHOUT falling back to SendPrompt.
func TestSteerSelf_Depth0_LiveRun_Steers(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: true}
	ctx := NewExtContext(acc, ExtContextOpts{Registry: NewDispatchRegistry(), Depth: 0})

	if ctx.SteerSelf == nil {
		t.Fatal("ctx.SteerSelf was not wired")
	}
	res, err := ctx.SteerSelf("[Agent done] result")
	if err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "steered" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=steered", res.Delivered, res.Outcome)
	}

	steerCalls, sendCalls := acc.snapshot()
	if len(steerCalls) != 1 || steerCalls[0] != "[Agent done] result" {
		t.Errorf("SteerSelfMainLoop calls = %v, want one with the message", steerCalls)
	}
	if len(sendCalls) != 0 {
		t.Errorf("SendPrompt should NOT be called when the main loop is live; got %v", sendCalls)
	}
}

// TestSteerSelf_Depth0_Idle_Sends verifies that at depth 0 with no live main
// run, SteerSelf falls back to SendPrompt and reports "sent".
//
// Revert-red: if the live-run branch is removed (always send) this still
// passes, but the companion live-run test above fails — together they pin the
// steer-vs-send decision.
func TestSteerSelf_Depth0_Idle_Sends(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: false}
	ctx := NewExtContext(acc, ExtContextOpts{Registry: NewDispatchRegistry(), Depth: 0})

	res, err := ctx.SteerSelf("idle message")
	if err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "sent" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=sent", res.Delivered, res.Outcome)
	}

	steerCalls, sendCalls := acc.snapshot()
	if len(steerCalls) != 1 {
		t.Errorf("SteerSelfMainLoop should be attempted once, got %v", steerCalls)
	}
	if len(sendCalls) != 1 || sendCalls[0] != "idle message" {
		t.Errorf("SendPrompt calls = %v, want one with the message (idle fallback)", sendCalls)
	}
}

// TestSteerSelf_DepthN_LiveChildRun_Steers verifies that at depth N the owning
// run is THIS dispatch's child run (addressed via the registry by dispatchId),
// not the root main loop. A live child run is steered and reports "steered";
// the root main-loop path is never touched.
func TestSteerSelf_DepthN_LiveChildRun_Steers(t *testing.T) {
	registry := NewDispatchRegistry()

	// Register this depth-1 dispatch's own child run as steerable + live.
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	registry.RegisterWithID("dispatch-self-abc", "depth1-agent", func() {}, child, "sess", "", 1)
	registry.SetChildRunID("dispatch-self-abc", "sess-dispatch-self-abc")

	acc := &steerSelfAccessor{mainLoopLive: true} // would steer main loop if depth-0 path taken
	ctx := NewExtContext(acc, ExtContextOpts{
		Registry:   registry,
		Depth:      1,
		DispatchId: "dispatch-self-abc",
	})

	res, err := ctx.SteerSelf("child completion bubbling up")
	if err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "steered" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=steered", res.Delivered, res.Outcome)
	}
	if !child.called {
		t.Error("expected the depth-N child run to be steered via the registry")
	}
	if child.lastMessage != "child completion bubbling up" {
		t.Errorf("child steered with %q, want the completion message", child.lastMessage)
	}

	// The depth-N path must NOT touch the root main loop.
	steerCalls, sendCalls := acc.snapshot()
	if len(steerCalls) != 0 {
		t.Errorf("depth-N steer must not call the root main loop, got %v", steerCalls)
	}
	if len(sendCalls) != 0 {
		t.Errorf("depth-N steer must not send a fresh prompt when the child run is live, got %v", sendCalls)
	}
}

// TestSteerSelf_DepthN_IdleChildRun_Sends verifies that when the depth-N child
// run is not live (SteerByID returns no_run), SteerSelf falls back to a fresh
// prompt so the completion is never dropped.
func TestSteerSelf_DepthN_IdleChildRun_Sends(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultNoRun}
	registry.RegisterWithID("dispatch-self-xyz", "depth1-agent", func() {}, child, "sess", "", 1)
	registry.SetChildRunID("dispatch-self-xyz", "sess-dispatch-self-xyz")

	acc := &steerSelfAccessor{}
	ctx := NewExtContext(acc, ExtContextOpts{
		Registry:   registry,
		Depth:      1,
		DispatchId: "dispatch-self-xyz",
	})

	res, err := ctx.SteerSelf("late completion")
	if err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "sent" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=sent", res.Delivered, res.Outcome)
	}

	_, sendCalls := acc.snapshot()
	if len(sendCalls) != 1 || sendCalls[0] != "late completion" {
		t.Errorf("SendPrompt calls = %v, want one with the message (idle child fallback)", sendCalls)
	}
}
