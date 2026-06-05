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
// spawner closure without spinning up a real ApiBackend or CliBackend.
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
	cancelCalled     bool
}

func (c *childStubBackend) StartRun(requestID string, opts types.RunOptions) {
	c.mu.Lock()
	c.startedRequestID = requestID
	c.startedOpts = opts
	onNorm := c.onNorm
	onExit := c.onExit
	gate := c.releaseGate
	result := c.resultText
	errToEmit := c.childErr
	c.mu.Unlock()

	go func() {
		// Wait for the gate when the test wants to hold the child open
		// (cancellation path). Nil gate = fire immediately (happy path
		// and child-error path).
		if gate != nil {
			<-gate
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

func (c *childStubBackend) IsRunning(_ string) bool                                    { return false }
func (c *childStubBackend) WriteToStdin(_ string, _ interface{}) error                 { return nil }
func (c *childStubBackend) FlushConversations()                                        {}
func (c *childStubBackend) OnNormalized(fn func(string, types.NormalizedEvent))        { c.onNorm = fn }
func (c *childStubBackend) OnExit(fn func(string, *int, *string, string))              { c.onExit = fn }
func (c *childStubBackend) OnError(fn func(string, error))                             { c.onError = fn }

// installHookCapturingHost registers in-memory agent_start / agent_end
// handlers on a fresh ExtensionGroup and returns the group together with
// pointers the test can inspect after the spawner runs.
type capturedAgentInfo struct {
	mu        sync.Mutex
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
		"",    // description
		"/tmp",
		"",    // model (empty — falls back to spec)
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
