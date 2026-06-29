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
	"github.com/dsswift/ion/engine/internal/types"
)

// bumpCountingAccessor is a minimal SessionAccessor that records how many times
// BumpParentProgress is called. It returns a child backend (set by the test)
// from NewChildBackend so a foreground dispatch can run end to end. All other
// methods are inert.
type bumpCountingAccessor struct {
	child     backend.RunBackend
	bumpCount atomic.Int64
	rootCtx   context.Context
}

func (a *bumpCountingAccessor) BumpParentProgress() { a.bumpCount.Add(1) }

func (a *bumpCountingAccessor) NewChildBackend() backend.RunBackend { return a.child }
func (a *bumpCountingAccessor) RootContext() context.Context {
	if a.rootCtx != nil {
		return a.rootCtx
	}
	return context.Background()
}

func (a *bumpCountingAccessor) SessionKey() string                       { return "bump-test-session" }
func (a *bumpCountingAccessor) ConversationID() string                   { return "" }
func (a *bumpCountingAccessor) WorkingDirectory() string                 { return "/tmp" }
func (a *bumpCountingAccessor) Emit(_ types.EngineEvent)                 {}
func (a *bumpCountingAccessor) SendAbort()                               {}
func (a *bumpCountingAccessor) SendPrompt(_, _ string, _ []string) error { return nil }
func (a *bumpCountingAccessor) SteerSelfMainLoop(_ string) bool          { return false }
func (a *bumpCountingAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *bumpCountingAccessor) SuppressTool(_ string)                          {}
func (a *bumpCountingAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (a *bumpCountingAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (a *bumpCountingAccessor) DeregisterAgent(_ string)                       {}
func (a *bumpCountingAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (a *bumpCountingAccessor) DeregisterAgentSpec(_ string)                   {}
func (a *bumpCountingAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *bumpCountingAccessor) LookupExtDisplayName(_ string) string     { return "" }
func (a *bumpCountingAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *bumpCountingAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *bumpCountingAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *bumpCountingAccessor) EngineConfig() *types.EngineRuntimeConfig { return nil }
func (a *bumpCountingAccessor) ResolveTier(_ string) string              { return "" }
func (a *bumpCountingAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *bumpCountingAccessor) McpConnections() []*mcp.Connection                      { return nil }
func (a *bumpCountingAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *bumpCountingAccessor) GetSessionMemory() string                               { return "" }
func (a *bumpCountingAccessor) SetSessionMemory(_ string)                              {}
func (a *bumpCountingAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *bumpCountingAccessor) SetPlanMode(_ bool, _ string)     {}
func (a *bumpCountingAccessor) GetPlanModeState() (bool, string) { return false, "" }
func (a *bumpCountingAccessor) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string {
	return ""
}
func (a *bumpCountingAccessor) UpdateAgentStateByID(_ string, _ func(*types.AgentStateUpdate)) {}
func (a *bumpCountingAccessor) EmitAgentSnapshot(_ string)                                     {}
func (a *bumpCountingAccessor) ResourceBroker() *resource.Broker                               { return nil }
func (a *bumpCountingAccessor) GlobalResourceBroker() *resource.Broker                         { return nil }
func (a *bumpCountingAccessor) BroadcastNotification(_ types.NotifyOpts)                       {}
func (a *bumpCountingAccessor) BroadcastIntercept(_ extension.InterceptOpts)                   {}
func (a *bumpCountingAccessor) ListAllSessions() []extension.SessionListEntry                  { return nil }
func (a *bumpCountingAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}
func (a *bumpCountingAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *bumpCountingAccessor) RunOnceComplete(_ string, _ bool)              {}

// drippingChildBackend emits a configurable number of normalized events then
// exits, simulating a healthy child agent producing activity. It implements the
// backend.RunBackend surface BuildDispatchAgentFunc needs.
type drippingChildBackend struct {
	mu        sync.Mutex
	onNorm    func(runID string, event types.NormalizedEvent)
	onExit    func(runID string, code *int, signal *string, sessionID string)
	onErr     func(runID string, err error)
	numEvents int
}

func (d *drippingChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}
func (d *drippingChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}
func (d *drippingChildBackend) OnError(fn func(string, error)) {
	d.mu.Lock()
	d.onErr = fn
	d.mu.Unlock()
}
func (d *drippingChildBackend) Cancel(string) bool                     { return false }
func (d *drippingChildBackend) IsRunning(string) bool                  { return false }
func (d *drippingChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *drippingChildBackend) FlushConversations()                    {}

func (d *drippingChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onNorm, onExit, n := d.onNorm, d.onExit, d.numEvents
	d.mu.Unlock()
	go func() {
		// Drip n genuine child events, then a TaskCompleteEvent, then exit.
		for i := 0; i < n; i++ {
			if onNorm != nil {
				onNorm(requestID, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "tick "}})
			}
			time.Sleep(5 * time.Millisecond)
		}
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done"}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, "child-conv-bump")
		}
	}()
}

// TestDispatchChildActivityBumpsParentProgress pins the parent-bump half of the
// dispatch-stall fix: a foreground dispatch whose child emits genuine events
// must call BumpParentProgress for each one, so the parent run's run-progress
// watchdog stays fresh while the child works (the parent is parked in the
// deadline-exempt Agent tool call and emits no progress of its own).
//
// On the code BEFORE the parent-bump wiring, the child OnNormalized handler did
// not call BumpParentProgress, so the bump count would be 0 — this test pins
// that the wiring exists and fires per child event.
func TestDispatchChildActivityBumpsParentProgress(t *testing.T) {
	const childEvents = 4
	child := &drippingChildBackend{numEvents: childEvents}
	acc := &bumpCountingAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name: "bump-test-agent",
		Task: "do work",
		// Foreground (Background defaults to false): runs synchronously and
		// returns once the child exits.
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}
	if result == nil {
		t.Fatal("dispatch returned nil result")
	}

	// The handler fires BumpParentProgress for EVERY child event: the
	// childEvents text chunks plus the terminal TaskCompleteEvent. Assert it
	// fired at least once per genuine child event (>= childEvents) — proving
	// child activity reaches the parent liveness clock. A count of 0 means the
	// wiring is missing (the pre-fix state).
	got := acc.bumpCount.Load()
	if got < childEvents {
		t.Errorf("BumpParentProgress fired %d times, want >= %d (one per genuine child event) — parent-liveness wiring missing or regressed", got, childEvents)
	}
}
