package session

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

type mockBackend struct {
	mu           sync.Mutex
	started      map[string]types.RunOptions
	cancelled    []string
	onNorm       func(string, types.NormalizedEvent)
	onExitF      func(string, *int, *string, string)
	onErrF       func(string, error)
}

func newMockBackend() *mockBackend {
	return &mockBackend{started: make(map[string]types.RunOptions)}
}

func (m *mockBackend) StartRun(requestID string, opts types.RunOptions) {
	m.mu.Lock()
	m.started[requestID] = opts
	m.mu.Unlock()
}

func (m *mockBackend) Cancel(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.started[requestID]; ok {
		m.cancelled = append(m.cancelled, requestID)
		return true
	}
	return false
}

func (m *mockBackend) IsRunning(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.started[requestID]
	return ok
}

func (m *mockBackend) WriteToStdin(_ string, _ interface{}) error { return nil }

func (m *mockBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onNorm = fn
}

func (m *mockBackend) OnExit(fn func(string, *int, *string, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onExitF = fn
}

func (m *mockBackend) OnError(fn func(string, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onErrF = fn
}

func (m *mockBackend) emitNormalized(runID string, event types.NormalizedEvent) {
	m.mu.Lock()
	fn := m.onNorm
	m.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (m *mockBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	m.mu.Lock()
	fn := m.onExitF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (m *mockBackend) emitError(runID string, err error) {
	m.mu.Lock()
	fn := m.onErrF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

func (m *mockBackend) startedKeys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.started))
	for k := range m.started {
		keys = append(keys, k)
	}
	return keys
}

func (m *mockBackend) getStarted(requestID string) (types.RunOptions, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	opts, ok := m.started[requestID]
	return opts, ok
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func defaultConfig() types.EngineConfig {
	return types.EngineConfig{
		ProfileID:        "test",
		ExtensionDir:     "/tmp",
		WorkingDirectory: "/tmp",
		Model:            "mock-model",
	}
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }

// eventCollector captures events emitted by the manager.
type eventCollector struct {
	mu     sync.Mutex
	events []keyedEvent
}

type keyedEvent struct {
	key   string
	event types.EngineEvent
}

func newEventCollector(mgr *Manager) *eventCollector {
	ec := &eventCollector{}
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		ec.mu.Lock()
		ec.events = append(ec.events, keyedEvent{key: key, event: event})
		ec.mu.Unlock()
	})
	return ec
}

func (ec *eventCollector) all() []keyedEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]keyedEvent, len(ec.events))
	copy(out, ec.events)
	return out
}

func (ec *eventCollector) byType(t string) []keyedEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	var out []keyedEvent
	for _, e := range ec.events {
		if e.event.Type == t {
			out = append(out, e)
		}
	}
	return out
}

func (ec *eventCollector) count() int {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	return len(ec.events)
}

// ---------------------------------------------------------------------------
// StartSession tests
// ---------------------------------------------------------------------------

func TestStartSession_CreatesSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.StartSession("s1", defaultConfig())
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "s1" {
		t.Errorf("expected key=s1, got %q", sessions[0].Key)
	}
	if sessions[0].HasActiveRun {
		t.Error("new session should not have active run")
	}
}

func TestStartSession_DuplicateKeyError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	if err := mgr.StartSession("dup", defaultConfig()); err != nil {
		t.Fatalf("first StartSession: %v", err)
	}

	err := mgr.StartSession("dup", defaultConfig())
	if err == nil {
		t.Fatal("expected error for duplicate key")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("expected 'already exists' in error, got %q", err.Error())
	}
}

func TestStartSession_EmitsStatusEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("s1", defaultConfig())

	statuses := ec.byType("engine_status")
	if len(statuses) != 1 {
		t.Fatalf("expected 1 status event, got %d", len(statuses))
	}
	if statuses[0].event.Fields == nil {
		t.Fatal("expected status fields")
	}
	if statuses[0].event.Fields.State != "idle" {
		t.Errorf("expected state=idle, got %q", statuses[0].event.Fields.State)
	}
	if statuses[0].event.Fields.Label != "s1" {
		t.Errorf("expected label=s1, got %q", statuses[0].event.Fields.Label)
	}
	if statuses[0].event.Fields.Model != "mock-model" {
		t.Errorf("expected model=mock-model, got %q", statuses[0].event.Fields.Model)
	}
}

func TestStartSession_MultipleSessions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for i := 0; i < 5; i++ {
		key := fmt.Sprintf("session-%d", i)
		if err := mgr.StartSession(key, defaultConfig()); err != nil {
			t.Fatalf("StartSession(%s): %v", key, err)
		}
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 5 {
		t.Fatalf("expected 5 sessions, got %d", len(sessions))
	}
}

// ---------------------------------------------------------------------------
// SendPrompt tests
// ---------------------------------------------------------------------------

func TestSendPrompt_ValidSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("p1", defaultConfig())

	err := mgr.SendPrompt("p1", "Hello world", nil)
	if err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	opts, _ := mb.getStarted(keys[0])
	if opts.Prompt != "Hello world" {
		t.Errorf("expected prompt 'Hello world', got %q", opts.Prompt)
	}
	if opts.ProjectPath != "/tmp" {
		t.Errorf("expected projectPath '/tmp', got %q", opts.ProjectPath)
	}
	if opts.Model != "mock-model" {
		t.Errorf("expected model 'mock-model', got %q", opts.Model)
	}
}

func TestSendPrompt_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.SendPrompt("nonexistent", "hello", nil)
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestSendPrompt_QueuesWhenBusy(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("busy", defaultConfig())

	if err := mgr.SendPrompt("busy", "first", nil); err != nil {
		t.Fatalf("first SendPrompt: %v", err)
	}

	// Second prompt should be queued, not rejected
	if err := mgr.SendPrompt("busy", "second", nil); err != nil {
		t.Fatalf("expected second prompt to be queued, got error: %v", err)
	}
}

func TestSendPrompt_QueueFullError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("busy", defaultConfig())

	if err := mgr.SendPrompt("busy", "first", nil); err != nil {
		t.Fatalf("first SendPrompt: %v", err)
	}

	// Fill the queue (default depth 32)
	for i := 0; i < 32; i++ {
		if err := mgr.SendPrompt("busy", fmt.Sprintf("queued-%d", i), nil); err != nil {
			t.Fatalf("queued prompt %d: %v", i, err)
		}
	}

	// 33rd should fail
	err := mgr.SendPrompt("busy", "overflow", nil)
	if err == nil {
		t.Fatal("expected error for full queue")
	}
	if !strings.Contains(err.Error(), "queue full") {
		t.Errorf("expected 'queue full' in error, got %q", err.Error())
	}
}

func TestSendPrompt_EmitsRunningStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("p1", defaultConfig())
	_ = mgr.SendPrompt("p1", "go", nil)

	statuses := ec.byType("engine_status")
	// Should have idle (from start) + running (from prompt)
	if len(statuses) < 2 {
		t.Fatalf("expected at least 2 status events, got %d", len(statuses))
	}
	last := statuses[len(statuses)-1]
	if last.event.Fields.State != "running" {
		t.Errorf("expected state=running, got %q", last.event.Fields.State)
	}
}

func TestSendPrompt_SetsRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("rid", defaultConfig())

	_ = mgr.SendPrompt("rid", "test", nil)

	if !mgr.IsRunning("rid") {
		t.Error("expected session to be running after SendPrompt")
	}

	keys := mb.startedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run, got %d", len(keys))
	}
	if !strings.HasPrefix(keys[0], "rid-") {
		t.Errorf("request ID should start with session key prefix, got %q", keys[0])
	}
}

func TestSendPrompt_PassesMaxTokens(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.MaxTokens = 4096
	_ = mgr.StartSession("mt", cfg)

	_ = mgr.SendPrompt("mt", "test", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if opts.MaxTokens != 4096 {
		t.Errorf("expected maxTokens=4096, got %d", opts.MaxTokens)
	}
}

func TestSendPrompt_PassesThinkingConfig(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.Thinking = &types.ThinkingConfig{Enabled: true, BudgetTokens: 8000}
	_ = mgr.StartSession("think", cfg)

	_ = mgr.SendPrompt("think", "ponder this", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if opts.Thinking == nil {
		t.Fatal("expected thinking config to be set")
	}
	if !opts.Thinking.Enabled {
		t.Error("expected thinking.enabled=true")
	}
	if opts.Thinking.BudgetTokens != 8000 {
		t.Errorf("expected budgetTokens=8000, got %d", opts.Thinking.BudgetTokens)
	}
}

// ---------------------------------------------------------------------------
// StopSession tests
// ---------------------------------------------------------------------------

func TestStopSession_CleansUp(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("stop-me", defaultConfig())

	err := mgr.StopSession("stop-me")
	if err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after stop, got %d", len(sessions))
	}
}

func TestStopSession_UnknownSessionError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.StopSession("ghost")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestStopSession_CancelsActiveRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("active", defaultConfig())
	_ = mgr.SendPrompt("active", "working", nil)

	if !mgr.IsRunning("active") {
		t.Fatal("session should be running")
	}

	_ = mgr.StopSession("active")

	// Backend should have received a Cancel call
	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount == 0 {
		t.Error("expected Cancel to be called on the backend")
	}
}

func TestStopSession_EmitsDeadEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("die", defaultConfig())
	_ = mgr.StopSession("die")

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Error("expected engine_dead event after stop")
	}
}

func TestStopSession_Idempotent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("once", defaultConfig())

	if err := mgr.StopSession("once"); err != nil {
		t.Fatalf("first stop: %v", err)
	}
	err := mgr.StopSession("once")
	if err == nil {
		t.Fatal("second stop should return error (session gone)")
	}
}

// ---------------------------------------------------------------------------
// StopAll tests
// ---------------------------------------------------------------------------

func TestStopAll_MultipleSessions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for _, key := range []string{"a", "b", "c", "d"} {
		_ = mgr.StartSession(key, defaultConfig())
	}

	if len(mgr.ListSessions()) != 4 {
		t.Fatal("expected 4 sessions")
	}

	err := mgr.StopAll()
	if err != nil {
		t.Fatalf("StopAll: %v", err)
	}

	if len(mgr.ListSessions()) != 0 {
		t.Error("expected 0 sessions after StopAll")
	}
}

func TestStopAll_EmptyManager(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.StopAll()
	if err != nil {
		t.Fatalf("StopAll on empty manager: %v", err)
	}
}

func TestStopAll_CancelsActiveRuns(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("r1", defaultConfig())
	_ = mgr.StartSession("r2", defaultConfig())
	_ = mgr.SendPrompt("r1", "work1", nil)
	_ = mgr.SendPrompt("r2", "work2", nil)

	_ = mgr.StopAll()

	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount < 2 {
		t.Errorf("expected at least 2 cancels, got %d", cancelCount)
	}
}

// ---------------------------------------------------------------------------
// StopByPrefix tests
// ---------------------------------------------------------------------------

func TestStopByPrefix_PrefixMatching(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for _, key := range []string{"app-1", "app-2", "app-3", "other-1", "other-2"} {
		_ = mgr.StartSession(key, defaultConfig())
	}

	mgr.StopByPrefix("app-")

	sessions := mgr.ListSessions()
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions remaining, got %d", len(sessions))
	}
	for _, s := range sessions {
		if strings.HasPrefix(s.Key, "app-") {
			t.Errorf("session %q should have been stopped", s.Key)
		}
	}
}

func TestStopByPrefix_NoMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("foo", defaultConfig())
	_ = mgr.StartSession("bar", defaultConfig())

	mgr.StopByPrefix("xyz-")

	if len(mgr.ListSessions()) != 2 {
		t.Error("no sessions should have been stopped")
	}
}

func TestStopByPrefix_ExactPrefixMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("abc", defaultConfig())
	_ = mgr.StartSession("abcdef", defaultConfig())
	_ = mgr.StartSession("ab", defaultConfig())

	mgr.StopByPrefix("abc")

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session remaining, got %d", len(sessions))
	}
	if sessions[0].Key != "ab" {
		t.Errorf("expected 'ab' to remain, got %q", sessions[0].Key)
	}
}

// ---------------------------------------------------------------------------
// ListSessions tests
// ---------------------------------------------------------------------------

func TestListSessions_Empty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	sessions := mgr.ListSessions()
	if sessions == nil {
		t.Fatal("expected non-nil slice")
	}
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(sessions))
	}
}

func TestListSessions_Populated(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("x", defaultConfig())
	_ = mgr.StartSession("y", defaultConfig())
	_ = mgr.StartSession("z", defaultConfig())

	sessions := mgr.ListSessions()
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}

	keys := make(map[string]bool)
	for _, s := range sessions {
		keys[s.Key] = true
	}
	for _, k := range []string{"x", "y", "z"} {
		if !keys[k] {
			t.Errorf("missing session key %q", k)
		}
	}
}

func TestListSessions_HasActiveRunFlag(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("idle-sess", defaultConfig())
	_ = mgr.StartSession("busy-sess", defaultConfig())
	_ = mgr.SendPrompt("busy-sess", "working", nil)

	sessions := mgr.ListSessions()
	for _, s := range sessions {
		switch s.Key {
		case "idle-sess":
			if s.HasActiveRun {
				t.Error("idle-sess should not have active run")
			}
		case "busy-sess":
			if !s.HasActiveRun {
				t.Error("busy-sess should have active run")
			}
		}
	}
}

func TestListSessions_AfterStopShowsReduced(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("keep", defaultConfig())
	_ = mgr.StartSession("remove", defaultConfig())
	_ = mgr.StopSession("remove")

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "keep" {
		t.Errorf("expected key=keep, got %q", sessions[0].Key)
	}
}

// ---------------------------------------------------------------------------
// SetPlanMode tests
// ---------------------------------------------------------------------------

func TestSetPlanMode_Enable(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("plan", defaultConfig())

	mgr.SetPlanMode("plan", true, []string{"Read", "Grep"})

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
	_ = mgr.StartSession("plan2", defaultConfig())

	mgr.SetPlanMode("plan2", true, []string{"Read"})
	mgr.SetPlanMode("plan2", false, nil)

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
	mgr.SetPlanMode("ghost", true, []string{"Read"})
}

// ---------------------------------------------------------------------------
// SendAbort tests
// ---------------------------------------------------------------------------

func TestSendAbort_CancelsActiveRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("abort-me", defaultConfig())
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
	_ = mgr.StartSession("idle-abort", defaultConfig())

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
	_ = mgr.StartSession("agent-abort", defaultConfig())

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
	_ = mgr.StartSession("tree", defaultConfig())

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
	_ = mgr.StartSession("s", defaultConfig())

	mgr.AbortAgent("s", "no-such-agent", false)
}

// ---------------------------------------------------------------------------
// SteerAgent tests
// ---------------------------------------------------------------------------

func TestSteerAgent_WritesToStdin(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("steer", defaultConfig())

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
	_ = mgr.StartSession("steer2", defaultConfig())

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
	_ = mgr.StartSession("steer3", defaultConfig())

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
	_ = mgr.StartSession("running", defaultConfig())
	_ = mgr.SendPrompt("running", "go", nil)

	if !mgr.IsRunning("running") {
		t.Error("expected IsRunning=true during active run")
	}
}

func TestIsRunning_FalseAfterExit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("exited", defaultConfig())
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
	_ = mgr.StartSession("idle", defaultConfig())

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
// Event forwarding tests
// ---------------------------------------------------------------------------

func TestHandleNormalizedEvent_TextChunk(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("ev", defaultConfig())
	_ = mgr.SendPrompt("ev", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hello"},
	})

	textEvents := ec.byType("engine_text_delta")
	if len(textEvents) == 0 {
		t.Fatal("expected engine_text_delta event")
	}
	if textEvents[0].event.TextDelta != "hello" {
		t.Errorf("expected text 'hello', got %q", textEvents[0].event.TextDelta)
	}
	if textEvents[0].key != "ev" {
		t.Errorf("expected key 'ev', got %q", textEvents[0].key)
	}
}

func TestHandleNormalizedEvent_ToolCall(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("tc", defaultConfig())
	_ = mgr.SendPrompt("tc", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool_123"},
	})

	toolEvents := ec.byType("engine_tool_start")
	if len(toolEvents) == 0 {
		t.Fatal("expected engine_tool_start event")
	}
	if toolEvents[0].event.ToolName != "Read" {
		t.Errorf("expected toolName 'Read', got %q", toolEvents[0].event.ToolName)
	}
	if toolEvents[0].event.ToolID != "tool_123" {
		t.Errorf("expected toolID 'tool_123', got %q", toolEvents[0].event.ToolID)
	}
}

func TestHandleNormalizedEvent_ToolResult(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("tr", defaultConfig())
	_ = mgr.SendPrompt("tr", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolResultEvent{ToolID: "tool_456", Content: "file contents", IsError: false},
	})

	toolEndEvents := ec.byType("engine_tool_end")
	if len(toolEndEvents) == 0 {
		t.Fatal("expected engine_tool_end event")
	}
	if toolEndEvents[0].event.ToolResult != "file contents" {
		t.Errorf("expected result 'file contents', got %q", toolEndEvents[0].event.ToolResult)
	}
}

func TestHandleNormalizedEvent_ToolResultError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("tre", defaultConfig())
	_ = mgr.SendPrompt("tre", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ToolResultEvent{ToolID: "tool_err", Content: "not found", IsError: true},
	})

	toolEndEvents := ec.byType("engine_tool_end")
	if len(toolEndEvents) == 0 {
		t.Fatal("expected engine_tool_end event")
	}
	if !toolEndEvents[0].event.ToolIsError {
		t.Error("expected ToolIsError=true")
	}
}

func TestHandleNormalizedEvent_TaskComplete(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("done", defaultConfig())
	_ = mgr.SendPrompt("done", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "All done", CostUsd: 0.05},
	})

	statusEvents := ec.byType("engine_status")
	found := false
	for _, e := range statusEvents {
		if e.event.Fields != nil && e.event.Fields.TotalCostUsd == 0.05 {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected engine_status with cost from TaskComplete")
	}
}

func TestHandleNormalizedEvent_ErrorEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("err", defaultConfig())
	_ = mgr.SendPrompt("err", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.ErrorEvent{ErrorMessage: "something broke"},
	})

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error event")
	}
	if errEvents[0].event.EventMessage != "something broke" {
		t.Errorf("expected 'something broke', got %q", errEvents[0].event.EventMessage)
	}
}

func TestHandleNormalizedEvent_UsageEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("usage", defaultConfig())
	_ = mgr.SendPrompt("usage", "go", nil)

	keys := mb.startedKeys()
	in, out := 1000, 500
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &in, OutputTokens: &out}},
	})

	msgEndEvents := ec.byType("engine_message_end")
	if len(msgEndEvents) == 0 {
		t.Fatal("expected engine_message_end event")
	}
	if msgEndEvents[0].event.EndUsage == nil {
		t.Fatal("expected EndUsage to be set")
	}
	if msgEndEvents[0].event.EndUsage.InputTokens != 1000 {
		t.Errorf("expected inputTokens=1000, got %d", msgEndEvents[0].event.EndUsage.InputTokens)
	}
	if msgEndEvents[0].event.EndUsage.OutputTokens != 500 {
		t.Errorf("expected outputTokens=500, got %d", msgEndEvents[0].event.EndUsage.OutputTokens)
	}
}

func TestHandleNormalizedEvent_SessionDead(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("dead", defaultConfig())
	_ = mgr.SendPrompt("dead", "go", nil)

	keys := mb.startedKeys()
	code := 1
	mb.emitNormalized(keys[0], types.NormalizedEvent{
		Data: &types.SessionDeadEvent{ExitCode: &code, StderrTail: []string{"panic"}},
	})

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event")
	}
	if deadEvents[0].event.ExitCode == nil || *deadEvents[0].event.ExitCode != 1 {
		t.Error("expected exitCode=1")
	}
	if len(deadEvents[0].event.StderrTail) == 0 || deadEvents[0].event.StderrTail[0] != "panic" {
		t.Error("expected stderrTail=['panic']")
	}
}

func TestHandleNormalizedEvent_NilDataReturnsError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("nildata", defaultConfig())
	_ = mgr.SendPrompt("nildata", "go", nil)

	keys := mb.startedKeys()
	mb.emitNormalized(keys[0], types.NormalizedEvent{Data: nil})

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error for nil event data")
	}
	if !strings.Contains(errEvents[0].event.EventMessage, "nil") {
		t.Errorf("expected message about nil, got %q", errEvents[0].event.EventMessage)
	}
}

func TestHandleNormalizedEvent_UnknownRunIDIgnored(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("s1", defaultConfig())

	// Emit event with a run ID that doesn't belong to any session
	initialCount := ec.count()
	mb.emitNormalized("unknown-run-id", types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "stray"},
	})

	// The initial count includes the start session status event.
	// No new events should appear.
	afterCount := ec.count()
	if afterCount != initialCount {
		t.Errorf("expected no new events for unknown run ID, got %d extra", afterCount-initialCount)
	}
}

// ---------------------------------------------------------------------------
// handleRunExit tests
// ---------------------------------------------------------------------------

func TestHandleRunExit_ClearsRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("exit", defaultConfig())
	_ = mgr.SendPrompt("exit", "go", nil)

	if !mgr.IsRunning("exit") {
		t.Fatal("should be running")
	}

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "conv-123")

	if mgr.IsRunning("exit") {
		t.Error("should no longer be running after exit")
	}
}

func TestHandleRunExit_SetsClaudeSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("sessid", defaultConfig())
	_ = mgr.SendPrompt("sessid", "go", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "claude-session-abc")

	// After exit, the claudeSession should be set. We verify by checking
	// the internal session state directly (same package).
	mgr.mu.RLock()
	s := mgr.sessions["sessid"]
	cs := s.claudeSession
	mgr.mu.RUnlock()

	if cs != "claude-session-abc" {
		t.Errorf("expected claudeSession='claude-session-abc', got %q", cs)
	}

	// Also verify the next prompt passes the session ID through.
	// Sleep 1ms to avoid timestamp collision in request ID.
	time.Sleep(time.Millisecond)
	_ = mgr.SendPrompt("sessid", "follow up", nil)

	keys2 := mb.startedKeys()
	for _, k := range keys2 {
		if k != keys[0] {
			opts, _ := mb.getStarted(k)
			if opts.SessionID != "claude-session-abc" {
				t.Errorf("expected sessionID 'claude-session-abc', got %q", opts.SessionID)
			}
			return
		}
	}
	t.Error("could not find second run")
}

func TestHandleRunExit_EmitsIdleStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("exit-idle", defaultConfig())
	_ = mgr.SendPrompt("exit-idle", "go", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "")

	statuses := ec.byType("engine_status")
	found := false
	for _, e := range statuses {
		if e.event.Fields != nil && e.event.Fields.State == "idle" && e.event.Fields.Label == "exit-idle" {
			found = true
		}
	}
	if !found {
		t.Error("expected engine_status with state=idle after exit")
	}
}

func TestHandleRunExit_EmitsDeadWithCodeAndSignal(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("exit-dead", defaultConfig())
	_ = mgr.SendPrompt("exit-dead", "go", nil)

	keys := mb.startedKeys()
	code := 137
	signal := "SIGKILL"
	mb.emitExit(keys[0], &code, &signal, "")

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event")
	}
	if deadEvents[0].event.ExitCode == nil || *deadEvents[0].event.ExitCode != 137 {
		t.Error("expected exitCode=137")
	}
	if deadEvents[0].event.Signal == nil || *deadEvents[0].event.Signal != "SIGKILL" {
		t.Error("expected signal=SIGKILL")
	}
}

func TestHandleRunExit_NilCodeAndSignal_NoDeadEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("exit-nil", defaultConfig())
	_ = mgr.SendPrompt("exit-nil", "go", nil)

	keys := mb.startedKeys()
	mb.emitExit(keys[0], nil, nil, "")

	deadEvents := ec.byType("engine_dead")
	// With both code and signal nil, no engine_dead should be emitted
	// (only the idle status event is emitted)
	if len(deadEvents) != 0 {
		t.Errorf("expected no engine_dead event when code and signal are nil, got %d", len(deadEvents))
	}
}

// ---------------------------------------------------------------------------
// handleRunError tests
// ---------------------------------------------------------------------------

func TestHandleRunError_EmitsErrorEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("runerr", defaultConfig())
	_ = mgr.SendPrompt("runerr", "go", nil)

	keys := mb.startedKeys()
	mb.emitError(keys[0], errors.New("provider timeout"))

	errEvents := ec.byType("engine_error")
	if len(errEvents) == 0 {
		t.Fatal("expected engine_error event")
	}
	if errEvents[0].event.EventMessage != "provider timeout" {
		t.Errorf("expected 'provider timeout', got %q", errEvents[0].event.EventMessage)
	}
}

func TestHandleRunError_UnknownRunIDIgnored(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("s", defaultConfig())
	initialCount := ec.count()

	mb.emitError("unknown-run", errors.New("stray error"))

	if ec.count() != initialCount {
		t.Error("expected no events for unknown run ID")
	}
}

// ---------------------------------------------------------------------------
// OnEvent tests
// ---------------------------------------------------------------------------

func TestOnEvent_NilCallbackNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	// No OnEvent registered
	_ = mgr.StartSession("s1", defaultConfig()) // emits an event -- should not panic
}

func TestOnEvent_ReplaceCallback(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var firstCount, secondCount int
	mgr.OnEvent(func(key string, event types.EngineEvent) { firstCount++ })
	_ = mgr.StartSession("s1", defaultConfig())

	mgr.OnEvent(func(key string, event types.EngineEvent) { secondCount++ })
	_ = mgr.StartSession("s2", defaultConfig())

	if firstCount != 1 {
		t.Errorf("first callback expected 1 call, got %d", firstCount)
	}
	if secondCount != 1 {
		t.Errorf("second callback expected 1 call, got %d", secondCount)
	}
}

// ---------------------------------------------------------------------------
// translateToEngineEvent tests
// ---------------------------------------------------------------------------

func TestTranslateToEngineEvent_AllTypes(t *testing.T) {
	tests := []struct {
		name     string
		input    types.NormalizedEvent
		wantType string
	}{
		{
			name:     "text_chunk",
			input:    types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "hi"}},
			wantType: "engine_text_delta",
		},
		{
			name:     "tool_call",
			input:    types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1"}},
			wantType: "engine_tool_start",
		},
		{
			name:     "tool_result",
			input:    types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", Content: "ok"}},
			wantType: "engine_tool_end",
		},
		{
			name:     "task_complete",
			input:    types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done", CostUsd: 0.1}},
			wantType: "engine_status",
		},
		{
			name:     "error",
			input:    types.NormalizedEvent{Data: &types.ErrorEvent{ErrorMessage: "boom"}},
			wantType: "engine_error",
		},
		{
			name: "usage",
			input: types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{
				InputTokens: intPtr(100), OutputTokens: intPtr(50),
			}}},
			wantType: "engine_message_end",
		},
		{
			name: "session_dead",
			input: types.NormalizedEvent{Data: &types.SessionDeadEvent{
				ExitCode: intPtr(1),
			}},
			wantType: "engine_dead",
		},
		{
			name:     "nil_data",
			input:    types.NormalizedEvent{Data: nil},
			wantType: "engine_error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := translateToEngineEvent(tt.input)
			if result.Type != tt.wantType {
				t.Errorf("expected type %q, got %q", tt.wantType, result.Type)
			}
		})
	}
}

func TestTranslateToEngineEvent_UnknownType(t *testing.T) {
	// SessionInitEvent is a valid NormalizedEventData but not handled
	// by the translateToEngineEvent switch (falls through to default).
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.SessionInitEvent{SessionID: "test"},
	})
	if result.Type != "" {
		t.Errorf("expected empty type for unknown events (silent drop), got %q", result.Type)
	}
}

func TestTranslateToEngineEvent_UsageContextPercent(t *testing.T) {
	in := 100000
	out := 50000
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{
			InputTokens: &in, OutputTokens: &out,
		}},
	})
	if result.EndUsage == nil {
		t.Fatal("expected EndUsage")
	}
	// (100000 + 50000) * 100 / 200000 = 75
	if result.EndUsage.ContextPercent != 75 {
		t.Errorf("expected contextPercent=75, got %d", result.EndUsage.ContextPercent)
	}
}

func TestTranslateToEngineEvent_UsageNilTokens(t *testing.T) {
	result := translateToEngineEvent(types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{}},
	})
	if result.EndUsage == nil {
		t.Fatal("expected EndUsage")
	}
	if result.EndUsage.ContextPercent != 0 {
		t.Errorf("expected contextPercent=0 with nil tokens, got %d", result.EndUsage.ContextPercent)
	}
	if result.EndUsage.InputTokens != 0 {
		t.Errorf("expected inputTokens=0, got %d", result.EndUsage.InputTokens)
	}
}

// ---------------------------------------------------------------------------
// isDescendant tests
// ---------------------------------------------------------------------------

func TestIsDescendant_DirectChild(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"parent": {PID: 1},
		"child":  {PID: 2, ParentAgent: "parent"},
	}
	if !isDescendant(reg, "child", "parent") {
		t.Error("child should be descendant of parent")
	}
}

func TestIsDescendant_GrandChild(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"root":       {PID: 1},
		"child":      {PID: 2, ParentAgent: "root"},
		"grandchild": {PID: 3, ParentAgent: "child"},
	}
	if !isDescendant(reg, "grandchild", "root") {
		t.Error("grandchild should be descendant of root")
	}
}

func TestIsDescendant_NotRelated(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1},
		"b": {PID: 2},
	}
	if isDescendant(reg, "b", "a") {
		t.Error("b should not be descendant of a")
	}
}

func TestIsDescendant_CycleProtection(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1, ParentAgent: "b"},
		"b": {PID: 2, ParentAgent: "a"},
	}
	// Should not loop forever
	result := isDescendant(reg, "a", "c")
	if result {
		t.Error("should not be descendant when ancestor not in cycle")
	}
}

func TestIsDescendant_SelfNotDescendant(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"a": {PID: 1},
	}
	if isDescendant(reg, "a", "a") {
		t.Error("a should not be descendant of itself")
	}
}

func TestIsDescendant_DeepChain(t *testing.T) {
	reg := map[string]types.AgentHandle{
		"n0": {PID: 1},
		"n1": {PID: 2, ParentAgent: "n0"},
		"n2": {PID: 3, ParentAgent: "n1"},
		"n3": {PID: 4, ParentAgent: "n2"},
		"n4": {PID: 5, ParentAgent: "n3"},
		"n5": {PID: 6, ParentAgent: "n4"},
	}
	if !isDescendant(reg, "n5", "n0") {
		t.Error("n5 should be descendant of n0")
	}
	if isDescendant(reg, "n0", "n5") {
		t.Error("n0 should not be descendant of n5")
	}
}

// ---------------------------------------------------------------------------
// Concurrent operations tests
// ---------------------------------------------------------------------------

func TestConcurrent_StartStop(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var wg sync.WaitGroup
	// Start 20 sessions concurrently
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("concurrent-%d", idx)
			_ = mgr.StartSession(key, defaultConfig())
		}(i)
	}
	wg.Wait()

	sessions := mgr.ListSessions()
	if len(sessions) != 20 {
		t.Fatalf("expected 20 sessions, got %d", len(sessions))
	}

	// Stop all concurrently
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("concurrent-%d", idx)
			_ = mgr.StopSession(key)
		}(i)
	}
	wg.Wait()

	if len(mgr.ListSessions()) != 0 {
		t.Error("expected 0 sessions after concurrent stop")
	}
}

func TestConcurrent_SimultaneousPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Start multiple sessions and send prompts concurrently
	for i := 0; i < 10; i++ {
		key := fmt.Sprintf("par-%d", i)
		_ = mgr.StartSession(key, defaultConfig())
	}

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("par-%d", idx)
			_ = mgr.SendPrompt(key, fmt.Sprintf("prompt-%d", idx), nil)
		}(i)
	}
	wg.Wait()

	keys := mb.startedKeys()
	if len(keys) != 10 {
		t.Errorf("expected 10 runs, got %d", len(keys))
	}
}

func TestConcurrent_ListDuringMutation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var wg sync.WaitGroup
	// Continuously list sessions while starting/stopping
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("mut-%d", idx)
			_ = mgr.StartSession(key, defaultConfig())
			time.Sleep(time.Millisecond)
			_ = mgr.StopSession(key)
		}(i)
		go func() {
			defer wg.Done()
			_ = mgr.ListSessions()
		}()
	}
	wg.Wait()
}

func TestConcurrent_EventEmissionDuringStop(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_ = mgr.StartSession("race", defaultConfig())
	_ = mgr.SendPrompt("race", "go", nil)

	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs started")
	}

	var wg sync.WaitGroup
	// Emit events while stopping
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			mb.emitNormalized(keys[0], types.NormalizedEvent{
				Data: &types.TextChunkEvent{Text: fmt.Sprintf("chunk-%d", i)},
			})
		}
	}()
	go func() {
		defer wg.Done()
		time.Sleep(time.Millisecond)
		_ = mgr.StopSession("race")
	}()
	wg.Wait()

	// Should not panic; event count is non-deterministic due to race
	_ = ec.count()
}

// ---------------------------------------------------------------------------
// ForkSession tests (unit-level -- no real conversation on disk)
// ---------------------------------------------------------------------------

func TestForkSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, err := mgr.ForkSession("nonexistent", 0)
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestForkSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("no-conv", defaultConfig())

	_, err := mgr.ForkSession("no-conv", 0)
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation' in error, got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// BranchSession tests (unit-level)
// ---------------------------------------------------------------------------

func TestBranchSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.BranchSession("nonexistent", "entry-1")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found', got %q", err.Error())
	}
}

func TestBranchSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("no-conv-branch", defaultConfig())

	err := mgr.BranchSession("no-conv-branch", "entry-1")
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation', got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// NavigateSession tests (unit-level)
// ---------------------------------------------------------------------------

func TestNavigateSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.NavigateSession("nonexistent", "target-1")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func TestNavigateSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("no-conv-nav", defaultConfig())

	err := mgr.NavigateSession("no-conv-nav", "target-1")
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation', got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// GetSessionTree tests (unit-level)
// ---------------------------------------------------------------------------

func TestGetSessionTree_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	tree := mgr.GetSessionTree("nonexistent")
	if tree != nil {
		t.Error("expected nil for unknown session")
	}
}

func TestGetSessionTree_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("no-conv-tree", defaultConfig())

	tree := mgr.GetSessionTree("no-conv-tree")
	if tree != nil {
		t.Error("expected nil for session with no conversation")
	}
}

// ---------------------------------------------------------------------------
// SendDialogResponse + SendCommand (placeholder coverage)
// ---------------------------------------------------------------------------

func TestSendDialogResponse_NoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("dlg", defaultConfig())

	// Should not panic even though not yet wired
	mgr.SendDialogResponse("dlg", "dialog-1", "yes")
	mgr.SendDialogResponse("nonexistent", "dialog-2", "no")
}

func TestSendCommand_NoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("cmd", defaultConfig())

	mgr.SendCommand("cmd", "reload", "")
	mgr.SendCommand("nonexistent", "reload", "")
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

func TestNewManager_RegistersCallbacks(t *testing.T) {
	mb := newMockBackend()
	_ = NewManager(mb)

	mb.mu.Lock()
	hasNorm := mb.onNorm != nil
	hasExit := mb.onExitF != nil
	hasErr := mb.onErrF != nil
	mb.mu.Unlock()

	if !hasNorm {
		t.Error("expected OnNormalized callback to be registered")
	}
	if !hasExit {
		t.Error("expected OnExit callback to be registered")
	}
	if !hasErr {
		t.Error("expected OnError callback to be registered")
	}
}

func TestEmit_NoCallbackNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	// Deliberately not setting OnEvent
	mgr.emit("key", types.EngineEvent{Type: "test"})
}

func TestDerefInt(t *testing.T) {
	if derefInt(nil) != 0 {
		t.Error("derefInt(nil) should be 0")
	}
	v := 42
	if derefInt(&v) != 42 {
		t.Errorf("derefInt(&42) should be 42, got %d", derefInt(&v))
	}
}

func TestKeyForRun_NotFound(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("s", defaultConfig())

	key := mgr.keyForRun("nonexistent-run")
	if key != "" {
		t.Errorf("expected empty key for unknown run, got %q", key)
	}
}

func TestKeyForRun_MatchesCorrectSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("s1", defaultConfig())
	_ = mgr.StartSession("s2", defaultConfig())
	_ = mgr.SendPrompt("s1", "go1", nil)
	_ = mgr.SendPrompt("s2", "go2", nil)

	keys := mb.startedKeys()
	for _, k := range keys {
		sessionKey := mgr.keyForRun(k)
		if sessionKey == "" {
			t.Errorf("keyForRun(%q) returned empty", k)
		}
		// The request ID starts with the session key
		if !strings.HasPrefix(k, sessionKey+"-") {
			t.Errorf("run %q does not match session %q", k, sessionKey)
		}
	}
}

func TestStopSession_AllowsRestart(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("restart", defaultConfig())
	_ = mgr.StopSession("restart")

	// Should be able to start again with the same key
	err := mgr.StartSession("restart", defaultConfig())
	if err != nil {
		t.Fatalf("expected restart to succeed, got %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session after restart, got %d", len(sessions))
	}
}

func TestSendPrompt_AfterRunExit_CanSendAgain(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("reuse", defaultConfig())
	_ = mgr.SendPrompt("reuse", "first", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "session-1")

	if mgr.IsRunning("reuse") {
		t.Fatal("session should not be running after exit")
	}

	// Sleep to ensure different timestamp for request ID
	time.Sleep(time.Millisecond)

	// Now should be able to send another prompt
	err := mgr.SendPrompt("reuse", "second", nil)
	if err != nil {
		t.Fatalf("expected second prompt to succeed, got %v", err)
	}

	if !mgr.IsRunning("reuse") {
		t.Error("session should be running after second prompt")
	}

	allKeys := mb.startedKeys()
	if len(allKeys) < 2 {
		t.Errorf("expected at least 2 runs total, got %d", len(allKeys))
	}
}

func TestStopByPrefix_EmptyPrefix(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_ = mgr.StartSession("a", defaultConfig())
	_ = mgr.StartSession("b", defaultConfig())

	// Empty prefix matches everything
	mgr.StopByPrefix("")

	if len(mgr.ListSessions()) != 0 {
		t.Error("empty prefix should match all sessions")
	}
}

func TestSetPlanMode_Toggle(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_ = mgr.StartSession("toggle", defaultConfig())

	// Enable
	mgr.SetPlanMode("toggle", true, []string{"Read"})
	// Disable
	mgr.SetPlanMode("toggle", false, nil)
	// Re-enable with different tools
	mgr.SetPlanMode("toggle", true, []string{"Grep", "Glob", "Read"})

	_ = mgr.SendPrompt("toggle", "go", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if !opts.PlanMode {
		t.Error("expected PlanMode=true")
	}
	if len(opts.PlanModeTools) != 3 {
		t.Errorf("expected 3 tools, got %d", len(opts.PlanModeTools))
	}
}
