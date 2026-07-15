package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// wireAgentSpawner -> agent_start / agent_end hook wiring tests
//
// These tests lock in the fix for #126: prior to this wiring, FireAgentStart
// and FireAgentEnd had zero call sites in the engine, so user extensions
// that registered agent_start/agent_end handlers received nothing at
// runtime. The spawner closure must fire both hooks on the parent
// extension group for every terminal path -- success, child error, and
// parent cancellation -- so observers can reliably pair start with end.
// ---------------------------------------------------------------------------

// childStubBackend is an in-process RunBackend used to drive the agent
// spawner closure without spinning up a real ApiBackend or ClaudeCodeBackend.
// Callers configure the events it should emit on StartRun and whether
// completion is immediate or gated on an explicit Release() call (for
// cancellation testing).
type childStubBackend struct {
	mu sync.Mutex

	onNorm  func(string, types.NormalizedEvent)
	onExit  func(string, *int, *string, string)
	onError func(string, error)

	// resultText is emitted as TaskCompleteEvent.Result before exit
	// (when releaseGate is nil, i.e. immediate completion).
	resultText string
	// emitModelFallback, when true, causes the stub to emit a synthetic
	// ModelFallbackEvent before the TaskCompleteEvent. Used by lifecycle
	// tests to verify the parent's agent_state snapshot sequence isn't
	// perturbed by intermediate workflow events from the child run.
	emitModelFallback bool
	// emitActivity, when true, causes the stub to emit a SessionInitEvent
	// (carrying the child conv id) followed by a ToolCallEvent +
	// ToolResultEvent pair and a TextChunkEvent BEFORE TaskCompleteEvent, so
	// tests can assert the spawner emits engine_dispatch_activity deltas for
	// the live transcript while the child is still running.
	emitActivity bool
	// childErr, when non-nil, is delivered via onError after StartRun
	// returns control.
	childErr error
	// releaseGate, when non-nil, holds StartRun's exit emission until
	// Release() (or Cancel) closes the channel. Used for the cancellation
	// path where we need the parent context to expire before the child
	// finishes naturally.
	releaseGate chan struct{}

	startedRequestID string
	startedOpts      types.RunOptions
	// startedCfg captures the RunConfig passed to StartRunWithConfig.
	// nil when the caller used plain StartRun (the pre-fix path) — that
	// distinction matters for tests that verify DefaultModel was actually
	// threaded into the child run.
	startedCfg   *backend.RunConfig
	cancelCalled bool
}

func (c *childStubBackend) StartRun(requestID string, opts types.RunOptions) {
	c.mu.Lock()
	c.startedRequestID = requestID
	c.startedOpts = opts
	onNorm := c.onNorm
	onExit := c.onExit
	gate := c.releaseGate
	result := c.resultText
	emitFallback := c.emitModelFallback
	emitActivity := c.emitActivity
	errToEmit := c.childErr
	c.mu.Unlock()

	go func() {
		// Wait for the gate when the test wants to hold the child open
		// (cancellation path). Nil gate = fire immediately (happy path
		// and child-error path).
		if gate != nil {
			<-gate
		}
		// Emit the live-transcript activity sequence (init → tool pair → text)
		// before completion so the spawner produces engine_dispatch_activity.
		if emitActivity && onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: "child-conv-id"}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool-1"}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tool-1", IsError: false}})
			onNorm(requestID, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "looking at the file"}})
		}
		// Emit a synthetic ModelFallbackEvent before the task-complete so
		// lifecycle tests can verify it doesn't perturb the parent's
		// engine_agent_state snapshot sequence.
		if emitFallback && onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{
				Data: &types.ModelFallbackEvent{
					RequestedModel: "standard",
					FallbackModel:  "claude-sonnet-4-6",
					Reason:         "no_provider_found",
				},
			})
		}
		if onNorm != nil && result != "" {
			onNorm(requestID, types.NormalizedEvent{
				Data: &types.TaskCompleteEvent{
					Result:    result,
					SessionID: "child-conv-id",
				},
			})
		}
		if errToEmit != nil {
			c.mu.Lock()
			fn := c.onError
			c.mu.Unlock()
			if fn != nil {
				fn(requestID, errToEmit)
			}
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, "child-conv-id")
		}
	}()
}

// StartRunWithConfig lets the shared dispatch path (extcontext.startChild,
// reached via BuildDispatchAgentFunc) route through this method when the
// spawner passes a non-nil RunConfig. Captures cfg alongside opts so tests can
// assert DefaultModel and the AgentSpawner were threaded through.
func (c *childStubBackend) StartRunWithConfig(requestID string, opts types.RunOptions, cfg *backend.RunConfig) {
	c.mu.Lock()
	c.startedCfg = cfg
	c.mu.Unlock()
	c.StartRun(requestID, opts)
}

func (c *childStubBackend) Cancel(_ string) bool {
	c.mu.Lock()
	c.cancelCalled = true
	gate := c.releaseGate
	c.mu.Unlock()
	// Release the gate so the StartRun goroutine can complete its
	// exit emission -- the spawner closure blocks waiting for doneCh
	// even after Cancel, mirroring production behavior.
	if gate != nil {
		select {
		case <-gate:
			// already closed
		default:
			close(gate)
		}
	}
	return true
}

func (c *childStubBackend) IsRunning(_ string) bool                             { return false }
func (c *childStubBackend) WriteToStdin(_ string, _ interface{}) error          { return nil }
func (c *childStubBackend) FlushConversations()                                 {}
func (c *childStubBackend) OnNormalized(fn func(string, types.NormalizedEvent)) { c.onNorm = fn }
func (c *childStubBackend) OnExit(fn func(string, *int, *string, string))       { c.onExit = fn }
func (c *childStubBackend) OnError(fn func(string, error))                      { c.onError = fn }

// installHookCapturingHost registers in-memory agent_start / agent_end
// handlers on a fresh ExtensionGroup and returns the group together with
// pointers the test can inspect after the spawner runs.
type capturedAgentInfo struct {
	mu         sync.Mutex
	startCalls []extension.AgentInfo
	endCalls   []extension.AgentInfo
}

func (c *capturedAgentInfo) starts() []extension.AgentInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]extension.AgentInfo, len(c.startCalls))
	copy(out, c.startCalls)
	return out
}

func (c *capturedAgentInfo) ends() []extension.AgentInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]extension.AgentInfo, len(c.endCalls))
	copy(out, c.endCalls)
	return out
}

func installHookCapturingGroup(t *testing.T) (*extension.ExtensionGroup, *capturedAgentInfo) {
	t.Helper()
	cap := &capturedAgentInfo{}
	host := extension.NewHost()
	host.SDK().On(extension.HookAgentStart, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		info, ok := payload.(extension.AgentInfo)
		if !ok {
			t.Errorf("agent_start payload not AgentInfo: %T", payload)
			return nil, nil
		}
		cap.mu.Lock()
		cap.startCalls = append(cap.startCalls, info)
		cap.mu.Unlock()
		return nil, nil
	})
	host.SDK().On(extension.HookAgentEnd, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		info, ok := payload.(extension.AgentInfo)
		if !ok {
			t.Errorf("agent_end payload not AgentInfo: %T", payload)
			return nil, nil
		}
		cap.mu.Lock()
		cap.endCalls = append(cap.endCalls, info)
		cap.mu.Unlock()
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group, cap
}

// runSpawnerOnce wires the agent spawner with a stub child backend, attaches
// the given extension group to the parent session, then invokes the closure
// once with the supplied parent context and prompt. Returns the spawner's
// result string, the capture of agent_start/agent_end payloads, and the
// spawner's error (error last per Go convention / staticcheck ST1008).
func runSpawnerOnce(t *testing.T, stub *childStubBackend, parentCtx context.Context, prompt string) (string, *capturedAgentInfo, error) {
	t.Helper()
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("spawner-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["spawner-test"]
	mgr.mu.Unlock()

	group, cap := installHookCapturingGroup(t)
	mgr.mu.Lock()
	s.extGroup = group
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "spawner-test", "claude-sonnet", group, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("wireAgentSpawner did not install AgentSpawner closure")
	}

	result, err := runCfg.AgentSpawner(parentCtx, "", prompt, "test-display", "/tmp", "")
	return result, cap, err
}

// TestWireAgentSpawner_EmitsDispatchActivity pins the Agent-tool spawn path's
// half of the live dispatched-agent transcript: a running sub-agent spawned via
// the built-in Agent tool must emit engine_dispatch_activity deltas (tool_start,
// tool_end, text) on the parent stream, mirroring the extension-dispatch path in
// dispatch_agent.go. This is the regression for the shipped gap where ONLY the
// extension-dispatch path was instrumented, so Agent-tool dispatches froze after
// the first tool on clients.
//
// Reverting the activity wiring in prompt_agent_spawner.go turns this red: no
// engine_dispatch_activity events are emitted.
func TestWireAgentSpawner_EmitsDispatchActivity(t *testing.T) {
	stub := &childStubBackend{resultText: "child output", emitActivity: true}

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	var mu sync.Mutex
	var activity []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_dispatch_activity" {
			mu.Lock()
			activity = append(activity, ev)
			mu.Unlock()
		}
	})

	if _, err := mgr.StartSession("activity-spawn", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["activity-spawn"]
	mgr.mu.Unlock()

	group, _ := installHookCapturingGroup(t)
	mgr.mu.Lock()
	s.extGroup = group
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "activity-spawn", "claude-sonnet", group, runCfg)
	if _, err := runCfg.AgentSpawner(context.Background(), "", "do thing", "disp", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	// The text delta is coalesced (~500ms flush) and flushed on Close at child
	// exit, so all three kinds are present by the time the spawner returns.
	mu.Lock()
	defer mu.Unlock()
	var sawToolStart, sawToolEnd, sawText bool
	lastSeq := 0
	for _, ev := range activity {
		if ev.DispatchConversationID != "child-conv-id" {
			t.Errorf("activity kind=%s conversationId=%q, want child-conv-id", ev.DispatchActivityKind, ev.DispatchConversationID)
		}
		if ev.DispatchAgentID == "" {
			t.Errorf("activity kind=%s missing DispatchAgentID", ev.DispatchActivityKind)
		}
		if ev.DispatchSeq <= lastSeq {
			t.Errorf("activity seq not monotonic: %d after %d", ev.DispatchSeq, lastSeq)
		}
		lastSeq = ev.DispatchSeq
		switch ev.DispatchActivityKind {
		case "tool_start":
			sawToolStart = true
			if ev.ToolID != "tool-1" || ev.ToolName != "Read" {
				t.Errorf("tool_start toolId=%q toolName=%q, want tool-1/Read", ev.ToolID, ev.ToolName)
			}
		case "tool_end":
			sawToolEnd = true
		case "text":
			sawText = true
			if ev.DispatchTextDelta != "looking at the file" {
				t.Errorf("text delta=%q, want coalesced full text", ev.DispatchTextDelta)
			}
		}
	}
	if !sawToolStart || !sawToolEnd || !sawText {
		t.Fatalf("missing activity kinds from Agent-tool spawn path: start=%v end=%v text=%v (got %d events)",
			sawToolStart, sawToolEnd, sawText, len(activity))
	}
}

func TestWireAgentSpawner_FiresAgentStartAndEnd_OnSuccess(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}
	result, cap, err := runSpawnerOnce(t, stub, context.Background(), "do thing")
	if err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}
	if result != "child output" {
		t.Fatalf("expected child output, got %q", result)
	}

	starts := cap.starts()
	ends := cap.ends()
	if len(starts) != 1 {
		t.Fatalf("expected 1 agent_start, got %d (%+v)", len(starts), starts)
	}
	if len(ends) != 1 {
		t.Fatalf("expected 1 agent_end, got %d (%+v)", len(ends), ends)
	}
	if starts[0].Task != "do thing" {
		t.Errorf("agent_start.Task = %q, want %q", starts[0].Task, "do thing")
	}
	if starts[0].Name == "" {
		t.Error("agent_start.Name must not be empty")
	}
	if ends[0].Name != starts[0].Name {
		t.Errorf("agent_end.Name = %q, want match agent_start.Name %q", ends[0].Name, starts[0].Name)
	}
	if ends[0].Task != "do thing" {
		t.Errorf("agent_end.Task = %q, want %q", ends[0].Task, "do thing")
	}
}

func TestWireAgentSpawner_FiresAgentEnd_OnChildError(t *testing.T) {
	stub := &childStubBackend{childErr: errors.New("child blew up")}
	_, cap, err := runSpawnerOnce(t, stub, context.Background(), "risky task")
	if err == nil || err.Error() != "child blew up" {
		t.Fatalf("expected child error to propagate, got %v", err)
	}

	if got := len(cap.starts()); got != 1 {
		t.Fatalf("expected 1 agent_start on error path, got %d", got)
	}
	if got := len(cap.ends()); got != 1 {
		t.Fatalf("expected 1 agent_end on error path, got %d", got)
	}
}

func TestWireAgentSpawner_FiresAgentEnd_OnCancellation(t *testing.T) {
	// Gate keeps the child "running" until parent cancellation triggers
	// the spawner's Cancel() path, which releases the gate.
	stub := &childStubBackend{
		resultText:  "never delivered",
		releaseGate: make(chan struct{}),
	}

	parentCtx, cancel := context.WithCancel(context.Background())
	// Cancel the parent context after a small delay so the spawner is
	// inside its select{} when cancellation lands.
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	_, cap, err := runSpawnerOnce(t, stub, parentCtx, "cancellable task")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from cancelled spawner, got %v", err)
	}

	if got := len(cap.starts()); got != 1 {
		t.Fatalf("expected 1 agent_start on cancellation path, got %d", got)
	}
	if got := len(cap.ends()); got != 1 {
		t.Fatalf("expected 1 agent_end on cancellation path (lifecycle pairing), got %d", got)
	}
}

// TestWireAgentSpawner_NilExtGroup_DoesNotPanic verifies the
// nil/empty-extGroup guard inside the spawner closure. Sessions without
// extensions are the common case and must not panic on agent dispatch.
func TestWireAgentSpawner_NilExtGroup_DoesNotPanic(t *testing.T) {
	stub := &childStubBackend{resultText: "ok"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("no-ext", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["no-ext"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "no-ext", "claude-sonnet", nil, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("AgentSpawner closure was not installed")
	}

	result, err := runCfg.AgentSpawner(context.Background(), "", "task", "", "/tmp", "")
	if err != nil {
		t.Fatalf("spawner returned error with nil extGroup: %v", err)
	}
	if result != "ok" {
		t.Fatalf("expected ok, got %q", result)
	}
}

// TestWireAgentSpawner_ResolvesTierAlias verifies that model tier aliases
// (e.g. "standard") from agent specs are resolved to concrete model IDs
// before the child backend receives them. This pins the fix for #174:
// prior to this fix, tier aliases passed through as literal strings and
// the child backend failed with "no provider found for model …".
func TestWireAgentSpawner_ResolvesTierAlias(t *testing.T) {
	// Set up a temp HOME with a models.json that maps "standard" to a
	// concrete model with fallbacks. ResolveTierChain reads from
	// ~/.ion/models.json on every call, so redirecting HOME is sufficient.
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]any{
		"tiers": map[string]any{
			"standard": map[string]any{
				"model":     "claude-sonnet-4-6",
				"fallbacks": []any{"claude-haiku-4-5"},
			},
		},
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)

	stub := &childStubBackend{resultText: "tier resolved"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("tier-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["tier-test"]
	mgr.mu.Unlock()

	// Register an agent spec with a tier alias as its model.
	s.agents.RegisterSpec(types.AgentSpec{
		Name:  "test-specialist",
		Model: "standard",
	})

	group, _ := installHookCapturingGroup(t)
	mgr.mu.Lock()
	s.extGroup = group
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "tier-test", "claude-opus-4-7", group, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("AgentSpawner not installed")
	}

	// Dispatch with a named specialist whose spec has model: "standard".
	// The LLM passes the name; the spawner resolves the spec, gets
	// "standard", and should resolve it to "claude-sonnet-4-6".
	result, spawnErr := runCfg.AgentSpawner(
		context.Background(),
		"test-specialist", // requestedName
		"audit the extension",
		"", // description
		"/tmp",
		"", // model (empty — falls back to spec)
	)
	if spawnErr != nil {
		t.Fatalf("spawner returned error: %v", spawnErr)
	}
	if result != "tier resolved" {
		t.Fatalf("expected %q, got %q", "tier resolved", result)
	}

	// Verify the child backend received the resolved concrete model,
	// not the raw tier alias.
	stub.mu.Lock()
	gotModel := stub.startedOpts.Model
	gotFallbacks := stub.startedOpts.FallbackChain
	stub.mu.Unlock()

	if gotModel != "claude-sonnet-4-6" {
		t.Errorf("child model = %q, want %q (tier alias should be resolved)", gotModel, "claude-sonnet-4-6")
	}
	if len(gotFallbacks) != 1 || gotFallbacks[0] != "claude-haiku-4-5" {
		t.Errorf("child fallbacks = %v, want [claude-haiku-4-5]", gotFallbacks)
	}
}

// TestWireAgentSpawner_ConcreteModelPassesThrough verifies that a concrete
// model ID (not a tier alias) passes through the tier resolution step
// unchanged. This is the no-op path — the spawner should not mangle a
// model that is already a concrete ID.
func TestWireAgentSpawner_ConcreteModelPassesThrough(t *testing.T) {
	// No models.json — all tier lookups pass through unchanged.
	t.Setenv("HOME", t.TempDir())

	stub := &childStubBackend{resultText: "ok"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("passthrough-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["passthrough-test"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "passthrough-test", "claude-opus-4-7", nil, runCfg)

	// Dispatch with an explicit concrete model from the call site.
	_, err := runCfg.AgentSpawner(
		context.Background(),
		"", "task", "", "/tmp",
		"claude-sonnet-4-6", // explicit concrete model
	)
	if err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	stub.mu.Lock()
	gotModel := stub.startedOpts.Model
	gotFallbacks := stub.startedOpts.FallbackChain
	stub.mu.Unlock()

	if gotModel != "claude-sonnet-4-6" {
		t.Errorf("child model = %q, want %q (concrete model should pass through)", gotModel, "claude-sonnet-4-6")
	}
	if len(gotFallbacks) != 0 {
		t.Errorf("child fallbacks = %v, want empty (no tier config)", gotFallbacks)
	}
}

// TestWireAgentSpawner_ThreadsDefaultModelToChild locks in the fix for the
// "child agent dispatched with unresolved tier alias" bug. When the agent
// spec declares `model: standard` but the user has no models.json (so
// ResolveTierChain returns "standard" verbatim), the spawner must still
// pass the engine's DefaultModel into the child's RunConfig so that the
// runloop fallback at runloop.go:57 can fire when the child's "standard"
// model doesn't resolve to a provider.
//
// Without this fix, the spawner called child.StartRun (no RunConfig), the
// runloop guard short-circuited (run.cfg == nil), and the child hard-failed
// with "no provider found for model standard". See the grand-surfing-moth
// plan §1.
func TestWireAgentSpawner_ThreadsDefaultModelToChild(t *testing.T) {
	// No ~/.ion/models.json — ResolveTierChain passes "standard" through
	// unchanged. This is the exact production case the bug surfaces in.
	t.Setenv("HOME", t.TempDir())

	stub := &childStubBackend{resultText: "ok"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	// Configure the engine with a DefaultModel — this is what should
	// propagate into the child's RunConfig so the runloop fallback can
	// fire. The fallback itself is exercised in
	// runloop_model_fallback_test.go; here we only assert the thread-through.
	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-sonnet-4-6",
	})

	if _, err := mgr.StartSession("threadthrough-test", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["threadthrough-test"]
	mgr.mu.Unlock()

	// Register an agent spec with a tier alias as its model. Without a
	// models.json mapping for "standard", ResolveTierChain returns the
	// input verbatim and the literal string "standard" reaches the
	// child run as the requested Model.
	s.agents.RegisterSpec(types.AgentSpec{
		Name:  "test-specialist",
		Model: "standard",
	})

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "threadthrough-test", "claude-opus-4-7", nil, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("AgentSpawner not installed")
	}

	_, spawnErr := runCfg.AgentSpawner(
		context.Background(),
		"test-specialist",
		"audit the extension",
		"", // description
		"/tmp",
		"", // model (empty — falls back to spec → "standard")
	)
	if spawnErr != nil {
		t.Fatalf("spawner returned error: %v", spawnErr)
	}

	// Guarantee: the child received a RunConfig via StartRunWithConfig
	// (not the bare StartRun path that loses RunConfig).
	stub.mu.Lock()
	gotCfg := stub.startedCfg
	gotModel := stub.startedOpts.Model
	stub.mu.Unlock()

	if gotCfg == nil {
		t.Fatal("child started with no RunConfig — the dispatch path must route through StartRunWithConfig so DefaultModel reaches the runloop fallback")
	}
	if gotCfg.DefaultModel != "claude-sonnet-4-6" {
		t.Errorf("child RunConfig.DefaultModel = %q, want %q (engine default must be threaded through)", gotCfg.DefaultModel, "claude-sonnet-4-6")
	}
	// The child still received the unresolved tier alias as its Model —
	// that's deliberate. The runloop is the layer that performs the swap
	// (see runloop_model_fallback_test.go).
	if gotModel != "standard" {
		t.Errorf("child opts.Model = %q, want %q (tier passthrough — runloop performs the swap)", gotModel, "standard")
	}
}

// ---------------------------------------------------------------------------
// Convergence regression tests: the orchestrator's Agent-tool spawner now
// routes through the single shared dispatch mechanism
// (extcontext.BuildDispatchAgentFunc). Before the convergence the bespoke
// wireAgentSpawner run loop never wired an AgentSpawner onto the child
// RunConfig (so a dispatched agent could not itself dispatch), never emitted
// engine_dispatch_start/end telemetry (so the desktop dispatch-preview popup
// found no nested children), and never stamped dispatchDepth/dispatchParentId
// on the agent pill. These tests pin all three; reverting the convergence in
// prompt_agent_spawner.go turns each red.
// ---------------------------------------------------------------------------

// TestWireAgentSpawner_WiresChildAgentSpawner is the BUG-2 root-cause pin: the
// child RunConfig handed to the dispatched agent's run MUST carry a non-nil
// AgentSpawner, so the dispatched agent (e.g. a Dev Lead) can itself invoke the
// Agent tool to dispatch a sub-agent (e.g. an Engine Dev). The pre-fix path
// built `&backend.RunConfig{DefaultModel: ...}` with no AgentSpawner, so the
// runloop hit the nil-spawner branch and the sub-dispatch never spawned.
func TestWireAgentSpawner_WiresChildAgentSpawner(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("spawner-wiring", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["spawner-wiring"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "spawner-wiring", "claude-sonnet", nil, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("wireAgentSpawner did not install AgentSpawner closure")
	}

	if _, err := runCfg.AgentSpawner(context.Background(), "", "do thing", "disp", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	stub.mu.Lock()
	gotCfg := stub.startedCfg
	stub.mu.Unlock()

	if gotCfg == nil {
		t.Fatal("child started with no RunConfig — AgentSpawner cannot be threaded")
	}
	if gotCfg.AgentSpawner == nil {
		t.Fatal("child RunConfig.AgentSpawner is nil — a dispatched agent cannot dispatch a sub-agent (BUG 2 root cause)")
	}
}

// TestWireAgentSpawner_SetsIsSubagent pins that the dispatched child run is
// marked IsSubagent so the early-stop continuation gate skips it. The
// orchestrator path always set this; the convergence preserves it by setting
// IsSubagent inside BuildDispatchAgentFunc.
func TestWireAgentSpawner_SetsIsSubagent(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("spawner-subagent", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["spawner-subagent"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "spawner-subagent", "claude-sonnet", nil, runCfg)
	if _, err := runCfg.AgentSpawner(context.Background(), "", "do thing", "disp", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	stub.mu.Lock()
	gotSubagent := stub.startedOpts.IsSubagent
	stub.mu.Unlock()

	if !gotSubagent {
		t.Error("child run opts.IsSubagent = false, want true (early-stop gate must skip dispatched subagents)")
	}
}

// TestWireAgentSpawner_EmitsDispatchTelemetry is the BUG-2 desktop-join pin:
// an orchestrator-dispatched agent must emit engine_dispatch_start AND
// engine_dispatch_end on the parent stream, carrying a non-empty DispatchId,
// DispatchDepth==1, and an empty DispatchParentId. The desktop dispatch-preview
// popup builds its child rows from this telemetry; without it the popup is
// always empty. The pre-fix path emitted only engine_agent_state.
func TestWireAgentSpawner_EmitsDispatchTelemetry(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	var mu sync.Mutex
	var starts, ends []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		mu.Lock()
		defer mu.Unlock()
		switch ev.Type {
		case "engine_dispatch_start":
			starts = append(starts, ev)
		case "engine_dispatch_end":
			ends = append(ends, ev)
		}
	})

	if _, err := mgr.StartSession("spawner-telemetry", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["spawner-telemetry"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "spawner-telemetry", "claude-sonnet", nil, runCfg)
	if _, err := runCfg.AgentSpawner(context.Background(), "", "brief me", "disp", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(starts) != 1 {
		t.Fatalf("expected 1 engine_dispatch_start, got %d", len(starts))
	}
	if len(ends) != 1 {
		t.Fatalf("expected 1 engine_dispatch_end, got %d", len(ends))
	}
	st := starts[0]
	if st.DispatchId == "" {
		t.Error("engine_dispatch_start.DispatchId is empty — desktop join key missing")
	}
	if st.DispatchDepth != 1 {
		t.Errorf("engine_dispatch_start.DispatchDepth = %d, want 1 (orchestrator's direct dispatch)", st.DispatchDepth)
	}
	if st.DispatchParentId != "" {
		t.Errorf("engine_dispatch_start.DispatchParentId = %q, want empty (orchestrator-direct)", st.DispatchParentId)
	}
	// end matches start by DispatchId so applyDispatchEnd can correlate.
	if ends[0].DispatchId != st.DispatchId {
		t.Errorf("engine_dispatch_end.DispatchId = %q, want %q (must match the start)", ends[0].DispatchId, st.DispatchId)
	}
}

// TestWireAgentSpawner_StampsPillAttribution pins that the dispatched agent's
// state pill carries dispatchDepth==1 and an empty dispatchParentId. The
// desktop's isRootLevelAgent reads these to keep an orchestrator's direct
// dispatch in the main panel; without them attribution defaults make the
// filter behave incorrectly for nested instances.
func TestWireAgentSpawner_StampsPillAttribution(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("spawner-attr", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["spawner-attr"]
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "spawner-attr", "claude-sonnet", nil, runCfg)
	if _, err := runCfg.AgentSpawner(context.Background(), "", "brief me", "disp", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	snap := s.agents.MergedSnapshot()
	if len(snap) == 0 {
		t.Fatal("no agent state pills after dispatch")
	}
	var found bool
	for _, a := range snap {
		if a.Metadata == nil {
			continue
		}
		depth, hasDepth := a.Metadata["dispatchDepth"]
		parent, hasParent := a.Metadata["dispatchParentId"]
		if !hasDepth || !hasParent {
			continue
		}
		found = true
		if d, _ := depth.(int); d != 1 {
			t.Errorf("pill dispatchDepth = %v, want 1", depth)
		}
		if p, _ := parent.(string); p != "" {
			t.Errorf("pill dispatchParentId = %q, want empty (orchestrator-direct)", p)
		}
	}
	if !found {
		t.Error("no pill carried dispatchDepth/dispatchParentId attribution metadata")
	}
}

// nestingStubBackend is a child stub whose StartRunWithConfig invokes the
// AgentSpawner wired onto its RunConfig — simulating a dispatched agent (the
// "Dev Lead") whose own LLM calls the Agent tool to dispatch a sub-agent (the
// "Engine Dev"). It dispatches exactly once (guarded by a sync.Once) with the
// configured sub-agent name, then completes.
type nestingStubBackend struct {
	mu           sync.Mutex
	onNorm       func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	subAgentName string
	dispatchOnce sync.Once
}

func (c *nestingStubBackend) StartRun(requestID string, _ types.RunOptions) {
	c.mu.Lock()
	onNorm := c.onNorm
	onExit := c.onExit
	c.mu.Unlock()
	if onNorm != nil {
		onNorm(requestID, types.NormalizedEvent{Data: &types.SessionInitEvent{SessionID: "lead-conv-id"}})
		onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "lead done", SessionID: "lead-conv-id"}})
	}
	if onExit != nil {
		onExit(requestID, nil, nil, "")
	}
}

func (c *nestingStubBackend) StartRunWithConfig(requestID string, opts types.RunOptions, cfg *backend.RunConfig) {
	// Before completing, dispatch a sub-agent through the spawner wired onto
	// this child's RunConfig — exactly what a dispatched agent's LLM does when
	// it calls the Agent tool. This is the path that was broken: the pre-fix
	// orchestrator spawner never set cfg.AgentSpawner, so this would be nil.
	c.dispatchOnce.Do(func() {
		if cfg != nil && cfg.AgentSpawner != nil {
			// Run in a goroutine so the spawner's foreground wait does not
			// deadlock against this synchronous StartRun emission below.
			go func() {
				_, _ = cfg.AgentSpawner(context.Background(), c.subAgentName, "do the sub task", "sub", "/tmp", "")
			}()
		}
	})
	c.StartRun(requestID, opts)
}

func (c *nestingStubBackend) Cancel(_ string) bool                                { return true }
func (c *nestingStubBackend) IsRunning(_ string) bool                             { return false }
func (c *nestingStubBackend) WriteToStdin(_ string, _ interface{}) error          { return nil }
func (c *nestingStubBackend) FlushConversations()                                 {}
func (c *nestingStubBackend) OnNormalized(fn func(string, types.NormalizedEvent)) { c.onNorm = fn }
func (c *nestingStubBackend) OnExit(fn func(string, *int, *string, string))       { c.onExit = fn }
func (c *nestingStubBackend) OnError(_ func(string, error))                       {}

// TestWireAgentSpawner_NestedDispatchChain is the end-to-end pin for the
// production id chain the desktop dispatch-preview popup relies on: the
// orchestrator dispatches A (the Dev Lead, depth 1, empty parent); A's child
// run invokes the Agent tool to dispatch B (the Engine Dev); B's
// engine_dispatch_start must carry DispatchDepth==2 and a DispatchParentId
// equal to A's DispatchId. childrenOfDispatch on the desktop matches B to A by
// exactly this (B.dispatchParentId == A.dispatchId), so this is the integration
// proof that nested children render under their parent in the popup. The
// pre-fix orchestrator path could not produce B at all (nil child AgentSpawner),
// so this test exercises the bug's full surface.
func TestWireAgentSpawner_NestedDispatchChain(t *testing.T) {
	leadStub := &nestingStubBackend{subAgentName: "engine-dev"}
	subStub := &childStubBackend{resultText: "engine dev brief"}

	mb := newMockBackend()
	mgr := NewManager(mb)
	// First child backend = the lead (which dispatches a sub-agent); every
	// subsequent child backend = the sub-agent's plain stub.
	var n int
	var nmu sync.Mutex
	mgr.childBackendOverride = func() backend.RunBackend {
		nmu.Lock()
		defer nmu.Unlock()
		n++
		if n == 1 {
			return leadStub
		}
		return subStub
	}

	var mu sync.Mutex
	var starts []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_dispatch_start" {
			mu.Lock()
			starts = append(starts, ev)
			mu.Unlock()
		}
	})

	if _, err := mgr.StartSession("nested-chain", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["nested-chain"]
	mgr.mu.Unlock()
	// Register the sub-agent spec so resolveAgentSpec matches it by name.
	s.agents.RegisterSpec(types.AgentSpec{Name: "engine-dev"})

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "nested-chain", "claude-sonnet", nil, runCfg)
	if _, err := runCfg.AgentSpawner(context.Background(), "dev-lead", "dispatch the engine dev", "lead", "/tmp", ""); err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	// The nested dispatch runs in a goroutine; give it a moment to emit its
	// start telemetry. Poll for the second start.
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		count := len(starts)
		mu.Unlock()
		if count >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(starts) < 2 {
		t.Fatalf("expected 2 engine_dispatch_start events (lead + nested engine-dev), got %d — nested dispatch never spawned (BUG 2)", len(starts))
	}

	// Identify the depth-1 (lead) and depth-2 (engine-dev) starts.
	var lead, nested *types.EngineEvent
	for i := range starts {
		switch starts[i].DispatchDepth {
		case 1:
			lead = &starts[i]
		case 2:
			nested = &starts[i]
		}
	}
	if lead == nil {
		t.Fatal("no depth-1 (lead) dispatch start found")
	}
	if nested == nil {
		t.Fatal("no depth-2 (nested engine-dev) dispatch start found")
	}
	if nested.DispatchParentId != lead.DispatchId {
		t.Errorf("nested.DispatchParentId = %q, want %q (must equal the lead's DispatchId so the desktop join matches the child to its parent)", nested.DispatchParentId, lead.DispatchId)
	}
	if lead.DispatchParentId != "" {
		t.Errorf("lead.DispatchParentId = %q, want empty (orchestrator-direct)", lead.DispatchParentId)
	}
}
