package extcontext

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// activityRecordingAccessor records every EngineEvent passed to Emit so the
// test can assert the engine_dispatch_activity stream a running dispatch
// produces. Agent-state methods store a single entry so SessionInitEvent
// capture works end to end.
type activityRecordingAccessor struct {
	noopPluginMethods
	child backend.RunBackend

	mu      sync.Mutex
	emitted []types.EngineEvent
	state   map[string]*types.AgentStateUpdate
}

func (a *activityRecordingAccessor) Emit(ev types.EngineEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.emitted = append(a.emitted, ev)
}

func (a *activityRecordingAccessor) activityEvents() []types.EngineEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []types.EngineEvent
	for _, ev := range a.emitted {
		if ev.Type == "engine_dispatch_activity" {
			out = append(out, ev)
		}
	}
	return out
}

// terminalEmitted reports whether a dispatch_end event has been emitted yet,
// so the test can assert activity fires while the dispatch is still running.
func (a *activityRecordingAccessor) terminalEmitted() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, ev := range a.emitted {
		if ev.Type == "engine_dispatch_end" {
			return true
		}
	}
	return false
}

func (a *activityRecordingAccessor) NewChildBackend() backend.RunBackend { return a.child }
func (a *activityRecordingAccessor) AllocatePlanFilePath() string        { return "/tmp/.ion/plans/plan.md" }
func (a *activityRecordingAccessor) RootContext() context.Context        { return context.Background() }

func (a *activityRecordingAccessor) AppendOrUpdateAgentState(s types.AgentStateUpdate) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state == nil {
		a.state = map[string]*types.AgentStateUpdate{}
	}
	cp := s
	a.state[s.ID] = &cp
	return s.ID
}

func (a *activityRecordingAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if st, ok := a.state[id]; ok {
		updater(st)
	}
}

func (a *activityRecordingAccessor) EmitAgentSnapshot(_ string) {}

func (a *activityRecordingAccessor) BumpParentProgress()              {}
func (a *activityRecordingAccessor) EmitDispatchCountStatus(_ string) {}

func (a *activityRecordingAccessor) SessionKey() string                       { return "activity-test-session" }
func (a *activityRecordingAccessor) ExtensionName() string    { return "" }
func (a *activityRecordingAccessor) ExtensionVersion() string { return "" }
func (a *activityRecordingAccessor) ConversationID() string                   { return "" }
func (a *activityRecordingAccessor) WorkingDirectory() string                 { return "/tmp" }
func (a *activityRecordingAccessor) SendAbort()                               {}
func (a *activityRecordingAccessor) SendPrompt(_, _ string, _ []string) error { return nil }
func (a *activityRecordingAccessor) SendPromptWithKind(_, _ string, _ []string, _ string) error {
	return nil
}
func (a *activityRecordingAccessor) SteerSelfMainLoop(_ string) bool          { return false }
func (a *activityRecordingAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *activityRecordingAccessor) SuppressTool(_ string)                          {}
func (a *activityRecordingAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (a *activityRecordingAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (a *activityRecordingAccessor) DeregisterAgent(_ string)                       {}
func (a *activityRecordingAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (a *activityRecordingAccessor) DeregisterAgentSpec(_ string)                   {}
func (a *activityRecordingAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *activityRecordingAccessor) LookupExtDisplayName(_ string) string     { return "" }
func (a *activityRecordingAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *activityRecordingAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *activityRecordingAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *activityRecordingAccessor) EngineConfig() *types.EngineRuntimeConfig { return nil }
func (a *activityRecordingAccessor) ClaudeCompat() bool { return false }
func (a *activityRecordingAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }
func (a *activityRecordingAccessor) ResolveTier(_ string) string              { return "" }
func (a *activityRecordingAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *activityRecordingAccessor) McpConnections() []*mcp.Connection { return nil }
func (a *activityRecordingAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch {
	return nil
}
func (a *activityRecordingAccessor) GetSessionMemory() string  { return "" }
func (a *activityRecordingAccessor) SetSessionMemory(_ string) {}
func (a *activityRecordingAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *activityRecordingAccessor) SetPlanMode(_ bool, _ string)                  {}
func (a *activityRecordingAccessor) GetPlanModeState() (bool, string)              { return false, "" }
func (a *activityRecordingAccessor) ResourceBroker() *resource.Broker              { return nil }
func (a *activityRecordingAccessor) GlobalResourceBroker() *resource.Broker        { return nil }
func (a *activityRecordingAccessor) BroadcastNotification(_ types.NotifyOpts)      {}
func (a *activityRecordingAccessor) BroadcastIntercept(_ extension.InterceptOpts)  {}
func (a *activityRecordingAccessor) ListAllSessions() []extension.SessionListEntry { return nil }
func (a *activityRecordingAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}

func (a *activityRecordingAccessor) FireSchedule(_, _ string) error { return nil }
func (a *activityRecordingAccessor) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (a *activityRecordingAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *activityRecordingAccessor) RunOnceComplete(_ string, _ bool)              {}
func (a *activityRecordingAccessor) Telemetry() *telemetry.Collector { return nil }

// activityChildBackend emits, before any TaskCompleteEvent: SessionInitEvent
// (the conv id), then a ToolCallEvent + ToolResultEvent pair, then a
// TextChunkEvent. The gate lets the test inspect mid-run state before the
// dispatch reaches a terminal state.
type activityChildBackend struct {
	mu       sync.Mutex
	onNorm   func(string, types.NormalizedEvent)
	onExit   func(string, *int, *string, string)
	convID   string
	workGate chan struct{}
	emitted  chan struct{} // closed after the pre-terminal deltas are delivered
}

func (d *activityChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}
func (d *activityChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}
func (d *activityChildBackend) OnError(func(string, error))            {}
func (d *activityChildBackend) Cancel(string) bool                     { return false }
func (d *activityChildBackend) IsRunning(string) bool                  { return false }
func (d *activityChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *activityChildBackend) FlushConversations()                    {}

func (d *activityChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onNorm, onExit := d.onNorm, d.onExit
	d.mu.Unlock()
	go func() {
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: d.convID}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool-1"}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tool-1", IsError: false}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "looking at the file"}})
		}
		close(d.emitted)
		<-d.workGate
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", SessionID: d.convID}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, d.convID)
		}
	}()
}

// TestDispatchEmitsActivityWhileRunning pins the engine push half of the
// live-dispatch-transcript fix: a running dispatch must emit
// engine_dispatch_activity deltas (tool_start, tool_end, text) on the parent
// stream WHILE the dispatch is still running — before any terminal event —
// each carrying the child conversation id, monotonic seq, and the right kind.
//
// Reverting the activity wiring in dispatch_agent.go turns this red: no
// engine_dispatch_activity events are emitted at all.
func TestDispatchEmitsActivityWhileRunning(t *testing.T) {
	const childConvID = "child-conv-activity"
	child := &activityChildBackend{
		convID:   childConvID,
		workGate: make(chan struct{}),
		emitted:  make(chan struct{}),
	}
	acc := &activityRecordingAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	done := make(chan struct{})
	go func() {
		_, _ = dispatchFn(extension.DispatchAgentOpts{Name: "activity-agent", Task: "do work"})
		close(done)
	}()

	// Wait for the child to deliver its pre-terminal deltas, then give the
	// dispatch goroutine and the ~500ms text-coalesce flush time to emit.
	<-child.emitted
	deadline := time.After(3 * time.Second)
	for {
		acts := acc.activityEvents()
		// Expect tool_start, tool_end, and the coalesced text delta.
		var sawToolStart, sawToolEnd, sawText bool
		for _, ev := range acts {
			switch ev.DispatchActivityKind {
			case "tool_start":
				sawToolStart = true
			case "tool_end":
				sawToolEnd = true
			case "text":
				sawText = true
			}
		}
		if sawToolStart && sawToolEnd && sawText {
			// All three kinds arrived BEFORE the dispatch reached terminal.
			if acc.terminalEmitted() {
				t.Fatal("activity events only observed after dispatch_end — must stream while running")
			}
			assertActivityShape(t, acts, childConvID)
			break
		}
		select {
		case <-deadline:
			t.Fatalf("did not observe all activity kinds before timeout: start=%v end=%v text=%v (got %d events)",
				sawToolStart, sawToolEnd, sawText, len(acts))
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	close(child.workGate)
	<-done
}

// assertActivityShape checks per-event field correctness and monotonic seq.
func assertActivityShape(t *testing.T, acts []types.EngineEvent, convID string) {
	t.Helper()
	lastSeq := 0
	for _, ev := range acts {
		if ev.DispatchConversationID != convID {
			t.Errorf("activity kind=%s conversationId=%q, want %q", ev.DispatchActivityKind, ev.DispatchConversationID, convID)
		}
		if ev.DispatchAgentID == "" {
			t.Errorf("activity kind=%s missing DispatchAgentID", ev.DispatchActivityKind)
		}
		if ev.DispatchSeq <= lastSeq {
			t.Errorf("activity seq not monotonic: got %d after %d (kind=%s)", ev.DispatchSeq, lastSeq, ev.DispatchActivityKind)
		}
		lastSeq = ev.DispatchSeq
		switch ev.DispatchActivityKind {
		case "tool_start":
			if ev.ToolID != "tool-1" || ev.ToolName != "Read" {
				t.Errorf("tool_start: toolId=%q toolName=%q, want tool-1/Read", ev.ToolID, ev.ToolName)
			}
		case "tool_end":
			if ev.ToolID != "tool-1" {
				t.Errorf("tool_end: toolId=%q, want tool-1", ev.ToolID)
			}
		case "text":
			if ev.DispatchTextDelta != "looking at the file" {
				t.Errorf("text: delta=%q, want coalesced full text", ev.DispatchTextDelta)
			}
		}
	}
}
