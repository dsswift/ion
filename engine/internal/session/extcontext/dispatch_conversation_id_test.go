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

// convIDRecordingAccessor is a SessionAccessor that stores agent state by ID so
// UpdateAgentStateByID mutates a real entry, and records every EmitAgentSnapshot
// reason. It lets the test observe what conversationId the agent metadata holds
// at the instant each snapshot fires — proving the id is populated mid-run.
type convIDRecordingAccessor struct {
	child backend.RunBackend

	mu sync.Mutex
	// state holds the single dispatched agent entry, keyed by agent ID.
	state map[string]*types.AgentStateUpdate
	// snapshots records, in order, the (reason, conversationId-at-that-instant)
	// captured every time EmitAgentSnapshot fires.
	snapshots []snapshotSample
}

type snapshotSample struct {
	reason         string
	conversationID string
	dispatchConvID string
	dispatchStatus string
}

func (a *convIDRecordingAccessor) NewChildBackend() backend.RunBackend { return a.child }
func (a *convIDRecordingAccessor) AllocatePlanFilePath() string        { return "/tmp/.ion/plans/plan.md" }
func (a *convIDRecordingAccessor) RootContext() context.Context        { return context.Background() }

func (a *convIDRecordingAccessor) AppendOrUpdateAgentState(s types.AgentStateUpdate) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state == nil {
		a.state = map[string]*types.AgentStateUpdate{}
	}
	cp := s
	a.state[s.ID] = &cp
	return s.ID
}

func (a *convIDRecordingAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.state[id]
	if !ok {
		return
	}
	updater(st)
}

func (a *convIDRecordingAccessor) EmitAgentSnapshot(reason string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	sample := snapshotSample{reason: reason}
	for _, st := range a.state {
		if st.Metadata == nil {
			continue
		}
		if cid, ok := st.Metadata["conversationId"].(string); ok {
			sample.conversationID = cid
		}
		// Read the dispatches[] entry to confirm the structured array carries
		// the id and status that clients (the desktop pager) read.
		if disp, ok := st.Metadata["dispatches"].([]interface{}); ok {
			for _, d := range disp {
				dm, ok := d.(map[string]interface{})
				if !ok {
					continue
				}
				if cid, ok := dm["conversationId"].(string); ok && cid != "" {
					sample.dispatchConvID = cid
				}
				if status, ok := dm["status"].(string); ok {
					sample.dispatchStatus = status
				}
			}
		}
	}
	a.snapshots = append(a.snapshots, sample)
}

// conversationIDs returns the conversationIds slice currently on the agent
// metadata, for the duplicate-append assertion.
func (a *convIDRecordingAccessor) conversationIDs() []interface{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, st := range a.state {
		if st.Metadata == nil {
			continue
		}
		if ids, ok := st.Metadata["conversationIds"].([]interface{}); ok {
			return ids
		}
	}
	return nil
}

func (a *convIDRecordingAccessor) BumpParentProgress()              {}
func (a *convIDRecordingAccessor) EmitDispatchCountStatus(_ string) {}

func (a *convIDRecordingAccessor) SessionKey() string                       { return "convid-test-session" }
func (a *convIDRecordingAccessor) ExtensionName() string    { return "" }
func (a *convIDRecordingAccessor) ExtensionVersion() string { return "" }
func (a *convIDRecordingAccessor) ConversationID() string                   { return "" }
func (a *convIDRecordingAccessor) WorkingDirectory() string                 { return "/tmp" }
func (a *convIDRecordingAccessor) Emit(_ types.EngineEvent)                 {}
func (a *convIDRecordingAccessor) SendAbort()                               {}
func (a *convIDRecordingAccessor) SendPrompt(_, _ string, _ []string) error { return nil }
func (a *convIDRecordingAccessor) SteerSelfMainLoop(_ string) bool          { return false }
func (a *convIDRecordingAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *convIDRecordingAccessor) SuppressTool(_ string)                          {}
func (a *convIDRecordingAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (a *convIDRecordingAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (a *convIDRecordingAccessor) DeregisterAgent(_ string)                       {}
func (a *convIDRecordingAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (a *convIDRecordingAccessor) DeregisterAgentSpec(_ string)                   {}
func (a *convIDRecordingAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *convIDRecordingAccessor) LookupExtDisplayName(_ string) string     { return "" }
func (a *convIDRecordingAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *convIDRecordingAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *convIDRecordingAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *convIDRecordingAccessor) EngineConfig() *types.EngineRuntimeConfig { return nil }
func (a *convIDRecordingAccessor) ClaudeCompat() bool { return false }
func (a *convIDRecordingAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }
func (a *convIDRecordingAccessor) ResolveTier(_ string) string              { return "" }
func (a *convIDRecordingAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *convIDRecordingAccessor) McpConnections() []*mcp.Connection                      { return nil }
func (a *convIDRecordingAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *convIDRecordingAccessor) GetSessionMemory() string                               { return "" }
func (a *convIDRecordingAccessor) SetSessionMemory(_ string)                              {}
func (a *convIDRecordingAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *convIDRecordingAccessor) SetPlanMode(_ bool, _ string)                  {}
func (a *convIDRecordingAccessor) GetPlanModeState() (bool, string)              { return false, "" }
func (a *convIDRecordingAccessor) ResourceBroker() *resource.Broker              { return nil }
func (a *convIDRecordingAccessor) GlobalResourceBroker() *resource.Broker        { return nil }
func (a *convIDRecordingAccessor) BroadcastNotification(_ types.NotifyOpts)      {}
func (a *convIDRecordingAccessor) BroadcastIntercept(_ extension.InterceptOpts)  {}
func (a *convIDRecordingAccessor) ListAllSessions() []extension.SessionListEntry { return nil }
func (a *convIDRecordingAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}

func (a *convIDRecordingAccessor) FireSchedule(_, _ string) error { return nil }
func (a *convIDRecordingAccessor) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (a *convIDRecordingAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *convIDRecordingAccessor) RunOnceComplete(_ string, _ bool)              {}
func (a *convIDRecordingAccessor) Telemetry() *telemetry.Collector { return nil }

// allConversationIDs returns every conversationIds slice across all agent
// state entries (not just the first hit). Used by the re-dispatch test to
// inspect the accumulated ids after multiple dispatches of the same name.
func (a *convIDRecordingAccessor) allConversationIDs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, st := range a.state {
		if st.Metadata == nil {
			continue
		}
		if ids, ok := st.Metadata["conversationIds"].([]interface{}); ok {
			for _, v := range ids {
				if s, ok := v.(string); ok {
					out = append(out, s)
				}
			}
		}
	}
	return out
}

// initThenWorkChildBackend simulates a child run that emits SessionInitEvent
// early (carrying its conversation id), then does some work (a tool call and a
// text chunk), then finishes with TaskCompleteEvent — mirroring the real child
// runloop ordering. The gap between init and completion is what lets the test
// assert the id is populated WHILE the dispatch is still running.
type initThenWorkChildBackend struct {
	mu        sync.Mutex
	onNorm    func(runID string, event types.NormalizedEvent)
	onExit    func(runID string, code *int, signal *string, sessionID string)
	convID    string
	workGate  chan struct{} // closed by the test to allow completion
	initFired chan struct{} // closed once SessionInitEvent has been delivered
}

func (d *initThenWorkChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}
func (d *initThenWorkChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}
func (d *initThenWorkChildBackend) OnError(func(string, error))            {}
func (d *initThenWorkChildBackend) Cancel(string) bool                     { return false }
func (d *initThenWorkChildBackend) IsRunning(string) bool                  { return false }
func (d *initThenWorkChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *initThenWorkChildBackend) FlushConversations()                    {}

func (d *initThenWorkChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onNorm, onExit := d.onNorm, d.onExit
	d.mu.Unlock()
	go func() {
		// 1. Emit SessionInitEvent FIRST — the early id signal.
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: d.convID}})
		}
		close(d.initFired)
		// 2. Do some "work" — a tool call and a text chunk — while running.
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1"}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "looking..."}})
		}
		// 3. Block until the test releases the gate, so the test can inspect
		//    mid-run state before TaskCompleteEvent ever fires.
		<-d.workGate
		// 4. Complete.
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", SessionID: d.convID}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, d.convID)
		}
	}()
}

// TestDispatchCapturesConversationIDFromSessionInit pins the engine half of the
// live-dispatch-stream fix: the child's conversation id must be written into the
// dispatch agent state (both metadata.conversationId and the structured
// dispatches[] entry) the moment SessionInitEvent arrives — while the dispatch
// is still running — not only at TaskCompleteEvent.
//
// Reverting the SessionInitEvent case in dispatch_agent.go turns this red: no
// snapshot carries the id while status == "running", because the id is captured
// only from TaskCompleteEvent at the end.
func TestDispatchCapturesConversationIDFromSessionInit(t *testing.T) {
	const childConvID = "child-conv-id"
	child := &initThenWorkChildBackend{
		convID:    childConvID,
		workGate:  make(chan struct{}),
		initFired: make(chan struct{}),
	}
	acc := &convIDRecordingAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	// Run the dispatch in the background so the test can inspect mid-run state
	// while the child backend is parked on its workGate.
	done := make(chan struct{})
	go func() {
		_, _ = dispatchFn(extension.DispatchAgentOpts{Name: "convid-agent", Task: "do work"})
		close(done)
	}()

	// Wait for the child to emit SessionInitEvent and the handler to process it.
	<-child.initFired
	// Give the dispatch goroutine a beat to run the OnNormalized handler that
	// writes the id and emits the snapshot.
	deadline := time.After(2 * time.Second)
	for {
		acc.mu.Lock()
		var found *snapshotSample
		for i := range acc.snapshots {
			if acc.snapshots[i].reason == "dispatch_conversation_id" {
				found = &acc.snapshots[i]
				break
			}
		}
		acc.mu.Unlock()
		if found != nil {
			// The id snapshot must have fired with the running dispatch still
			// running and the id populated on both surfaces.
			if found.conversationID != childConvID {
				t.Fatalf("snapshot metadata.conversationId = %q, want %q", found.conversationID, childConvID)
			}
			if found.dispatchConvID != childConvID {
				t.Fatalf("snapshot dispatches[].conversationId = %q, want %q", found.dispatchConvID, childConvID)
			}
			if found.dispatchStatus != "running" {
				t.Fatalf("snapshot dispatches[].status = %q, want \"running\" (id must be captured mid-run)", found.dispatchStatus)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("no \"dispatch_conversation_id\" snapshot fired before timeout — conversationId not captured from SessionInitEvent while running")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	// Release the gate so the dispatch completes cleanly.
	close(child.workGate)
	<-done

	// After completion, conversationIds must contain the id exactly once — the
	// terminal append must not duplicate the early-captured id.
	ids := acc.conversationIDs()
	count := 0
	for _, v := range ids {
		if s, ok := v.(string); ok && s == childConvID {
			count++
		}
	}
	if count != 1 {
		t.Errorf("conversationIds contains id %d times, want exactly 1 (no duplicate from terminal append): %v", count, ids)
	}
}

// --- Re-dispatch uniqueness test ---

// factoryAccessor wraps convIDRecordingAccessor but returns a fresh child
// backend from a factory on each NewChildBackend call. This lets the test
// dispatch the same agent name multiple times, each getting a backend that
// emits a distinct conversation ID.
type factoryAccessor struct {
	convIDRecordingAccessor
	factory func() backend.RunBackend
}

func (a *factoryAccessor) NewChildBackend() backend.RunBackend { return a.factory() }

// requestIDEchoChildBackend is a child backend that uses the requestID it
// receives from StartRun as its emitted conversation/session ID. This models
// the real-world behavior where a non-unique requestID leads to conversation
// reuse: if two dispatches share the same requestID, this backend emits the
// same conversation ID for both, reproducing the bug.
type requestIDEchoChildBackend struct {
	mu     sync.Mutex
	onNorm func(runID string, event types.NormalizedEvent)
	onExit func(runID string, code *int, signal *string, sessionID string)
}

func (d *requestIDEchoChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}
func (d *requestIDEchoChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}
func (d *requestIDEchoChildBackend) OnError(func(string, error))            {}
func (d *requestIDEchoChildBackend) Cancel(string) bool                     { return false }
func (d *requestIDEchoChildBackend) IsRunning(string) bool                  { return false }
func (d *requestIDEchoChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *requestIDEchoChildBackend) FlushConversations()                    {}

func (d *requestIDEchoChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onNorm, onExit := d.onNorm, d.onExit
	d.mu.Unlock()
	// Use requestID as the conversation ID. When the requestID is the same
	// across dispatches (the bug), the emitted conversation IDs are identical.
	convID := requestID
	go func() {
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: convID}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", SessionID: convID}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, convID)
		}
	}()
}

// TestRedispatchSameNameGetDistinctConversationIDs dispatches the same agent
// name twice through BuildDispatchAgentFunc and asserts each dispatch captures
// a distinct child conversation ID. The child run id is derived from the
// per-dispatch-unique agentID (which carries a NewConvSuffix() component), so
// uniqueness no longer depends on the two dispatches landing on different
// milliseconds. This test fails on code that derives the run id from
// name + UnixMilli() (sequential or concurrent dispatches of the same name
// would then share a run id and reuse one conversation) and passes after the
// agentID-based fix.
func TestRedispatchSameNameGetDistinctConversationIDs(t *testing.T) {
	factory := func() backend.RunBackend {
		return &requestIDEchoChildBackend{}
	}

	acc := &factoryAccessor{factory: factory}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	// First dispatch: foreground, blocks until complete.
	r1, err := dispatchFn(extension.DispatchAgentOpts{Name: "same-agent", Task: "first task"})
	if err != nil {
		t.Fatalf("first dispatch error: %v", err)
	}

	// Second dispatch of the SAME agent name. No sleep: uniqueness comes from
	// the agentID suffix, not from the millisecond timestamp.
	r2, err := dispatchFn(extension.DispatchAgentOpts{Name: "same-agent", Task: "second task"})
	if err != nil {
		t.Fatalf("second dispatch error: %v", err)
	}

	// The two results must carry distinct session IDs.
	if r1.SessionID == "" {
		t.Fatal("first dispatch returned empty SessionID")
	}
	if r2.SessionID == "" {
		t.Fatal("second dispatch returned empty SessionID")
	}
	if r1.SessionID == r2.SessionID {
		t.Errorf("both dispatches returned the same SessionID %q, want distinct IDs", r1.SessionID)
	}

	// The conversationIds metadata must hold two distinct entries.
	ids := acc.allConversationIDs()
	if len(ids) < 2 {
		t.Fatalf("conversationIds has %d entries, want at least 2: %v", len(ids), ids)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if len(seen) < 2 {
		t.Errorf("conversationIds has %d distinct values, want at least 2: %v", len(seen), ids)
	}
}

// TestConcurrentSameMillisDispatchesGetDistinctConversationIDs is the
// regression test for the same-millisecond dispatch collision. It dispatches
// the same agent name twice WITHOUT any sleep, so both dispatches observe the
// same start.UnixMilli(). With a run id derived from name + UnixMilli(), both
// children would share a run id and the requestID-echoing backend would emit
// the SAME conversation id for both — leaving one dispatch entry without its
// own conversation. With the agentID-based run id, each dispatch's NewConvSuffix()
// makes the run id (and therefore the echoed conversation id) distinct.
//
// This fails on the unfixed code (identical childReqID → identical echoed
// convId) and passes after the fix. Reverting the childReqID change in
// dispatch_agent.go turns this red.
func TestConcurrentSameMillisDispatchesGetDistinctConversationIDs(t *testing.T) {
	factory := func() backend.RunBackend {
		return &requestIDEchoChildBackend{}
	}

	acc := &factoryAccessor{factory: factory}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	// Two foreground dispatches of the same name, back to back with no sleep.
	// Both very likely land on the same UnixMilli; the test asserts uniqueness
	// regardless, which is exactly the property the fix guarantees.
	r1, err := dispatchFn(extension.DispatchAgentOpts{Name: "same-agent", Task: "first task"})
	if err != nil {
		t.Fatalf("first dispatch error: %v", err)
	}
	r2, err := dispatchFn(extension.DispatchAgentOpts{Name: "same-agent", Task: "second task"})
	if err != nil {
		t.Fatalf("second dispatch error: %v", err)
	}

	if r1.SessionID == "" || r2.SessionID == "" {
		t.Fatalf("dispatch returned empty SessionID: r1=%q r2=%q", r1.SessionID, r2.SessionID)
	}
	if r1.SessionID == r2.SessionID {
		t.Errorf("same-millisecond dispatches returned the same SessionID %q, want distinct IDs (run-id collision)", r1.SessionID)
	}

	ids := acc.allConversationIDs()
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if len(seen) < 2 {
		t.Errorf("conversationIds has %d distinct values, want 2 — same-millisecond dispatches collided: %v", len(seen), ids)
	}
}
