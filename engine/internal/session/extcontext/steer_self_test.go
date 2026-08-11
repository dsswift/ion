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
//
// Both recorders capture the KIND alongside the message. An accessor that
// discarded the kind could not observe the defect these tests exist to pin:
// the injection arriving unclassified is exactly the failure, and a mock that
// throws the kind away reports success either way.
type steerSelfAccessor struct {
	noopPluginMethods
	mu sync.Mutex

	mainLoopLive bool

	steerMainLoopCalls []string
	sendPromptCalls    []string

	// Kinds observed on each path, index-aligned with the calls above.
	steerMainLoopKinds []string
	sendPromptKinds    []string

	// sendPromptDegraded records, per send and index-aligned with
	// sendPromptCalls, whether it arrived through the degraded-steer entry
	// point (SendPromptDegradedSteer) rather than the plain kind-aware send.
	sendPromptDegraded []bool
}

func (a *steerSelfAccessor) SessionKey() string           { return "steer-self-test" }
func (a *steerSelfAccessor) ExtensionName() string        { return "" }
func (a *steerSelfAccessor) ExtensionVersion() string     { return "" }
func (a *steerSelfAccessor) ConversationID() string       { return "conv-steer" }
func (a *steerSelfAccessor) RunID() string                { return "" }
func (a *steerSelfAccessor) TraceID() string              { return "" }
func (a *steerSelfAccessor) WorkingDirectory() string     { return "/tmp" }
func (a *steerSelfAccessor) CurrentModel() string         { return "" }
func (a *steerSelfAccessor) Emit(ev types.EngineEvent)    {}
func (a *steerSelfAccessor) SendAbort()                   {}
func (a *steerSelfAccessor) RootContext() context.Context { return context.Background() }

func (a *steerSelfAccessor) SendPrompt(text string, model string, bash []string) error {
	return a.SendPromptWithKind(text, model, bash, "")
}

func (a *steerSelfAccessor) SendPromptWithKind(text string, model string, bash []string, kind string) error {
	return a.recordSend(text, kind, false)
}

func (a *steerSelfAccessor) SendPromptDegradedSteer(text string, model string, bash []string, kind string) error {
	return a.recordSend(text, kind, true)
}

func (a *steerSelfAccessor) recordSend(text, kind string, degraded bool) error {
	a.mu.Lock()
	a.sendPromptCalls = append(a.sendPromptCalls, text)
	a.sendPromptKinds = append(a.sendPromptKinds, kind)
	a.sendPromptDegraded = append(a.sendPromptDegraded, degraded)
	a.mu.Unlock()
	return nil
}

// degradedSends reports, per recorded send and in call order, whether it came
// through the degraded-steer entry point.
func (a *steerSelfAccessor) degradedSends() []bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]bool(nil), a.sendPromptDegraded...)
}

func (a *steerSelfAccessor) SteerSelfMainLoop(message string) bool {
	return a.SteerSelfMainLoopWithKind(message, "")
}

func (a *steerSelfAccessor) SteerSelfMainLoopWithKind(message, kind string) bool {
	a.mu.Lock()
	a.steerMainLoopCalls = append(a.steerMainLoopCalls, message)
	a.steerMainLoopKinds = append(a.steerMainLoopKinds, kind)
	live := a.mainLoopLive
	a.mu.Unlock()
	return live
}

func (a *steerSelfAccessor) ParkSelfMainLoop() bool { return false }

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
func (a *steerSelfAccessor) LookupExtDisplayName(name string) string              { return "" }
func (a *steerSelfAccessor) ExtGroup() *extension.ExtensionGroup                  { return nil }
func (a *steerSelfAccessor) ExtConfig() *extension.ExtensionConfig                { return nil }
func (a *steerSelfAccessor) ProcRegistry() *extension.ProcessRegistry             { return nil }
func (a *steerSelfAccessor) NewChildBackend() backend.RunBackend                  { return backend.NewApiBackend() }
func (a *steerSelfAccessor) AllocatePlanFilePath(_ string) string                 { return "/tmp/.ion/plans/plan.md" }
func (a *steerSelfAccessor) BumpParentProgress()                                  {}
func (a *steerSelfAccessor) EmitDispatchCountStatus(_ string)                     {}
func (a *steerSelfAccessor) EngineConfig() *types.EngineRuntimeConfig             { return nil }
func (a *steerSelfAccessor) ClaudeCompat() bool                                   { return false }
func (a *steerSelfAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }
func (a *steerSelfAccessor) ResolveTier(name string) string                       { return name }
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
func (a *steerSelfAccessor) UpsertAgentStateByID(id string, seed types.AgentStateUpdate, updater func(*types.AgentStateUpdate)) {
}
func (a *steerSelfAccessor) EmitAgentSnapshot(reason string)                 {}
func (a *steerSelfAccessor) ResourceBroker() *resource.Broker                { return nil }
func (a *steerSelfAccessor) GlobalResourceBroker() *resource.Broker          { return nil }
func (a *steerSelfAccessor) BroadcastNotification(opts types.NotifyOpts)     {}
func (a *steerSelfAccessor) BroadcastIntercept(opts extension.InterceptOpts) {}
func (a *steerSelfAccessor) ListAllSessions() []extension.SessionListEntry   { return nil }
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
func (a *steerSelfAccessor) Telemetry() *telemetry.Collector                 { return nil }

func (a *steerSelfAccessor) snapshot() (steerCalls, sendCalls []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.steerMainLoopCalls...), append([]string(nil), a.sendPromptCalls...)
}

// kindSnapshot returns the kinds observed on each delivery path, index-aligned
// with snapshot()'s messages.
func (a *steerSelfAccessor) kindSnapshot() (steerKinds, sendKinds []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.steerMainLoopKinds...), append([]string(nil), a.sendPromptKinds...)
}

// TestSteerSelf_Depth0_LiveRun_Steers verifies that at depth 0 with a live
// main run, SteerSelf injects via the main-loop steer and reports "steered"
// WITHOUT falling back to SendPrompt.
func TestSteerSelf_Depth0_LiveRun_Steers(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: true}
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

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
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

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
	ctx := NewExtContext(acc, registry, ExtContextOpts{
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
	ctx := NewExtContext(acc, registry, ExtContextOpts{
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
func (a *steerSelfAccessor) DispatchRegistry() *DispatchRegistry { return nil }

// ─── Injection-kind threading (the reported defect) ───
//
// The bug: a scheduled check-in delivered through steerSelf rendered as a USER
// message in the desktop transcript. ctx.SteerSelf took no kind, and its idle
// fallback called the three-arg SendPrompt, which hardcodes kind "". A harness
// was therefore structurally unable to classify a machine-to-machine turn, and
// every consumer rendered it as something the user typed.
//
// Each test below fails with the fix reverted: revert SteerSelfWithKind and the
// kind arrives as "" on the path under test.

// TestSteerSelfWithKind_Depth0_Idle_CarriesKindToSendPrompt is the exact
// reported failure. An idle orchestrator receiving a check-in must persist it
// as a checkin-kind injection, not as an unclassified user turn.
func TestSteerSelfWithKind_Depth0_Idle_CarriesKindToSendPrompt(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: false}
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

	if ctx.SteerSelfWithKind == nil {
		t.Fatal("ctx.SteerSelfWithKind was not wired")
	}
	res, err := ctx.SteerSelfWithKind("[SYSTEM] Dispatch check-in", string(types.InjectionKindCheckIn))
	if err != nil {
		t.Fatalf("SteerSelfWithKind returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "sent" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=sent", res.Delivered, res.Outcome)
	}

	_, sendKinds := acc.kindSnapshot()
	if len(sendKinds) != 1 {
		t.Fatalf("expected exactly one SendPrompt on the idle path, got %d", len(sendKinds))
	}
	if sendKinds[0] != string(types.InjectionKindCheckIn) {
		t.Errorf("idle fallback delivered kind %q, want %q. An empty kind here is the "+
			"reported bug: the injection reaches the transcript as a user bubble.",
			sendKinds[0], types.InjectionKindCheckIn)
	}
}

// TestSteerSelfWithKind_Depth0_LiveRun_CarriesKindToSteer pins the live arm.
// A machine steer into a running turn must reach the steer channel classified,
// or drainSteer persists it as a plain user turn.
func TestSteerSelfWithKind_Depth0_LiveRun_CarriesKindToSteer(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: true}
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

	res, err := ctx.SteerSelfWithKind("[Agent done] result", string(types.InjectionKindAgentCompletion))
	if err != nil {
		t.Fatalf("SteerSelfWithKind returned error: %v", err)
	}
	if !res.Delivered || res.Outcome != "steered" {
		t.Errorf("got delivered=%v outcome=%q, want delivered=true outcome=steered", res.Delivered, res.Outcome)
	}

	steerKinds, sendKinds := acc.kindSnapshot()
	if len(steerKinds) != 1 || steerKinds[0] != string(types.InjectionKindAgentCompletion) {
		t.Errorf("live steer delivered kinds %v, want one %q", steerKinds, types.InjectionKindAgentCompletion)
	}
	if len(sendKinds) != 0 {
		t.Errorf("SendPrompt must not be called when the main loop is live; got %v", sendKinds)
	}
}

// TestSteerSelfWithKind_DepthN_IdleChild_CarriesKindToSendPrompt pins the
// n-tier fallback. A lead's specialist completing after the lead's own run has
// exited routes through the fresh-prompt path, which must stay classified.
func TestSteerSelfWithKind_DepthN_IdleChild_CarriesKindToSendPrompt(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultNoRun}
	registry.RegisterWithID("dispatch-kind-1", "depth1-agent", func() {}, child, "sess", "", 1)
	registry.SetChildRunID("dispatch-kind-1", "sess-dispatch-kind-1")

	acc := &steerSelfAccessor{}
	ctx := NewExtContext(acc, registry, ExtContextOpts{
		Depth:      1,
		DispatchId: "dispatch-kind-1",
	})

	if _, err := ctx.SteerSelfWithKind("late completion", string(types.InjectionKindAgentCompletion)); err != nil {
		t.Fatalf("SteerSelfWithKind returned error: %v", err)
	}

	_, sendKinds := acc.kindSnapshot()
	if len(sendKinds) != 1 || sendKinds[0] != string(types.InjectionKindAgentCompletion) {
		t.Errorf("depth-N idle fallback delivered kinds %v, want one %q", sendKinds, types.InjectionKindAgentCompletion)
	}
}

// TestSteerSelfWithKind_DepthN_LiveChild_CarriesKindToRegistry pins the kind
// reaching the child run's steer channel through SteerByIDWithKind.
func TestSteerSelfWithKind_DepthN_LiveChild_CarriesKindToRegistry(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	registry.RegisterWithID("dispatch-kind-2", "depth1-agent", func() {}, child, "sess", "", 1)
	registry.SetChildRunID("dispatch-kind-2", "sess-dispatch-kind-2")

	acc := &steerSelfAccessor{}
	ctx := NewExtContext(acc, registry, ExtContextOpts{
		Depth:      1,
		DispatchId: "dispatch-kind-2",
	})

	if _, err := ctx.SteerSelfWithKind("bubbling up", string(types.InjectionKindAgentCompletion)); err != nil {
		t.Fatalf("SteerSelfWithKind returned error: %v", err)
	}
	if child.lastKind != string(types.InjectionKindAgentCompletion) {
		t.Errorf("child run steered with kind %q, want %q", child.lastKind, types.InjectionKindAgentCompletion)
	}
}

// TestSteerSelf_KindlessAliasStaysUnclassified pins that the plain SteerSelf
// alias still delivers an EMPTY kind.
//
// This is the boundary that keeps the change additive: an existing caller that
// never passed a kind must not suddenly have its turns classified. Only a
// caller that opts in by naming a kind gets one.
func TestSteerSelf_KindlessAliasStaysUnclassified(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: false}
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

	if _, err := ctx.SteerSelf("an ordinary turn"); err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}

	steerKinds, sendKinds := acc.kindSnapshot()
	if len(steerKinds) != 1 || steerKinds[0] != "" {
		t.Errorf("kindless SteerSelf produced steer kinds %v, want one empty", steerKinds)
	}
	if len(sendKinds) != 1 || sendKinds[0] != "" {
		t.Errorf("kindless SteerSelf produced send kinds %v, want one empty", sendKinds)
	}
}

// TestSteerSelf_DegradedDeliveryIsMarkedDegraded pins that both fallback arms
// route through SendPromptDegradedSteer rather than the plain kind-aware send.
//
// The flag is what makes the backend persist the steer marker that drainSteer
// writes on the live-run path. Without it a degraded machine turn is suppressed
// with no trace, and an operator sees a tool sweep begin with nothing in the
// transcript explaining why.
//
// Revert-red: point either arm back at SendPromptWithKind and the recorded flag
// flips to false.
func TestSteerSelf_DegradedDeliveryIsMarkedDegraded(t *testing.T) {
	t.Run("depth 0, idle main loop", func(t *testing.T) {
		acc := &steerSelfAccessor{mainLoopLive: false}
		ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

		if _, err := ctx.SteerSelf("[SYSTEM] Dispatch check-in"); err != nil {
			t.Fatalf("SteerSelf returned error: %v", err)
		}

		degraded := acc.degradedSends()
		if len(degraded) != 1 {
			t.Fatalf("expected exactly one send on the idle fallback, got %d", len(degraded))
		}
		if !degraded[0] {
			t.Error("the depth-0 fallback must deliver as a degraded steer so the marker is persisted")
		}
	})

	t.Run("depth N, idle child run", func(t *testing.T) {
		registry := NewDispatchRegistry()
		child := &mockSteerableBackend{result: backend.SteerResultNoRun}
		registry.RegisterWithID("dispatch-degraded-1", "depth1-agent", func() {}, child, "sess", "", 1)
		registry.SetChildRunID("dispatch-degraded-1", "sess-dispatch-degraded-1")

		acc := &steerSelfAccessor{}
		ctx := NewExtContext(acc, registry, ExtContextOpts{
			Depth:      1,
			DispatchId: "dispatch-degraded-1",
		})

		if _, err := ctx.SteerSelf("late completion"); err != nil {
			t.Fatalf("SteerSelf returned error: %v", err)
		}

		degraded := acc.degradedSends()
		if len(degraded) != 1 {
			t.Fatalf("expected exactly one send on the idle child fallback, got %d", len(degraded))
		}
		if !degraded[0] {
			t.Error("the depth-N fallback must deliver as a degraded steer so the marker is persisted")
		}
	})
}

// A channel-full child is still live. Its fresh-prompt fallback prevents a
// drop, but must not claim ctx.steerSelf found no owning run.
func TestSteerSelf_DepthN_ChannelFullIsNotDegraded(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultChannelFull}
	registry.RegisterWithID("dispatch-full-1", "depth1-agent", func() {}, child, "sess", "", 1)
	registry.SetChildRunID("dispatch-full-1", "sess-dispatch-full-1")

	acc := &steerSelfAccessor{}
	ctx := NewExtContext(acc, registry, ExtContextOpts{Depth: 1, DispatchId: "dispatch-full-1"})
	if _, err := ctx.SteerSelf("queued steer overflow"); err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}

	degraded := acc.degradedSends()
	if len(degraded) != 1 {
		t.Fatalf("expected one fallback send, got %d", len(degraded))
	}
	if degraded[0] {
		t.Error("channel_full proves a live child run; fallback must not be marked degraded")
	}
}

// A steer that REACHED a live run must not be marked degraded: drainSteer
// already persists the marker on that path, and a second one would double the
// divider. Together with the test above this pins that the flag tracks the
// degradation specifically, not steerSelf in general.
func TestSteerSelf_LiveDeliveryIsNotMarkedDegraded(t *testing.T) {
	acc := &steerSelfAccessor{mainLoopLive: true}
	ctx := NewExtContext(acc, NewDispatchRegistry(), ExtContextOpts{Depth: 0})

	if _, err := ctx.SteerSelf("mid-turn steer"); err != nil {
		t.Fatalf("SteerSelf returned error: %v", err)
	}

	if degraded := acc.degradedSends(); len(degraded) != 0 {
		t.Errorf("a live steer must not inject a prompt at all, got %d sends", len(degraded))
	}
}
