package session

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// newCliSession creates a minimal engineSession for CLI hook tests.
func newCliSession(key string) *engineSession {
	return &engineSession{
		key:       key,
		config:    defaultConfig(),
		agents:    agents.NewRegistry(),
		childPIDs: make(map[int]struct{}),
		pending:   pending.New(),
	}
}

// ---------------------------------------------------------------------------
// fireBeforePromptCli tests
// ---------------------------------------------------------------------------

func TestFireBeforePromptCli_ModifiesPromptAndSystem(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("cli1")

	host := extension.NewHost()
	host.SDK().On(extension.HookBeforePrompt, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		return extension.BeforePromptResult{
			Prompt:       "rewritten by extension",
			SystemPrompt: "injected system prompt",
		}, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{Prompt: "original prompt"}
	mgr.fireBeforePromptCli(s, "cli1", group, false, &opts)

	if opts.Prompt != "rewritten by extension" {
		t.Errorf("expected prompt rewritten, got %q", opts.Prompt)
	}
	if opts.AppendSystemPrompt != "injected system prompt" {
		t.Errorf("expected system prompt injected, got %q", opts.AppendSystemPrompt)
	}
}

func TestFireBeforePromptCli_AppendsToExistingSystem(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("cli2")

	host := extension.NewHost()
	host.SDK().On(extension.HookBeforePrompt, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		return extension.BeforePromptResult{SystemPrompt: "extra"}, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{
		Prompt:             "keep this",
		AppendSystemPrompt: "existing",
	}
	mgr.fireBeforePromptCli(s, "cli2", group, false, &opts)

	if opts.Prompt != "keep this" {
		t.Errorf("expected prompt unchanged, got %q", opts.Prompt)
	}
	if !strings.Contains(opts.AppendSystemPrompt, "existing") {
		t.Error("expected existing system prompt preserved")
	}
	if !strings.Contains(opts.AppendSystemPrompt, "extra") {
		t.Error("expected new system prompt appended")
	}
}

func TestFireBeforePromptCli_NoopForNonCliBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	s := newCliSession("mock1")

	host := extension.NewHost()
	host.SDK().On(extension.HookBeforePrompt, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		return "should not be applied", nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{Prompt: "original"}
	mgr.fireBeforePromptCli(s, "mock1", group, false, &opts)

	if opts.Prompt != "original" {
		t.Errorf("expected prompt unchanged for non-CLI backend, got %q", opts.Prompt)
	}
}

func TestFireBeforePromptCli_SkippedWhenSkipExtensions(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("cli3")

	host := extension.NewHost()
	host.SDK().On(extension.HookBeforePrompt, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		return "should not fire", nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{Prompt: "original"}
	mgr.fireBeforePromptCli(s, "cli3", group, true, &opts) // skipExtensions=true

	if opts.Prompt != "original" {
		t.Errorf("expected prompt unchanged when skipExtensions=true, got %q", opts.Prompt)
	}
}

func TestFireBeforePromptCli_NoopWhenNoExtGroup(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("cli4")

	opts := types.RunOptions{Prompt: "original"}
	mgr.fireBeforePromptCli(s, "cli4", nil, false, &opts)

	if opts.Prompt != "original" {
		t.Errorf("expected prompt unchanged with nil extGroup, got %q", opts.Prompt)
	}
}

// ---------------------------------------------------------------------------
// StartSession extension re-registration tests
// ---------------------------------------------------------------------------

func TestStartSession_ReRegistersExtensionsOnExistingSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// First start -- no extensions
	_, err := mgr.StartSession("reext", defaultConfig())
	if err != nil {
		t.Fatalf("first StartSession: %v", err)
	}

	// Verify session has no extensions
	mgr.mu.RLock()
	s := mgr.sessions["reext"]
	hasExt := s.extGroup != nil && !s.extGroup.IsEmpty()
	mgr.mu.RUnlock()
	if hasExt {
		t.Fatal("expected no extensions on initial session")
	}

	// Second start with extensions -- these are fake paths that will fail to load,
	// but the code path should be exercised (load failure is logged, group stays empty)
	cfgWithExt := defaultConfig()
	cfgWithExt.Extensions = []string{"/nonexistent/extension.js"}

	result, err := mgr.StartSession("reext", cfgWithExt)
	if err != nil {
		t.Fatalf("second StartSession: %v", err)
	}
	if !result.Existed {
		t.Error("expected Existed=true")
	}
}

func TestStartSession_DoesNotReRegisterWhenExtensionsExist(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Create session
	_, _ = mgr.StartSession("hasext", defaultConfig())

	// Manually wire an extension group
	host := extension.NewHost()
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.mu.Lock()
	s := mgr.sessions["hasext"]
	s.extGroup = group
	mgr.mu.Unlock()

	// Second start with extensions -- should NOT attempt to reload
	cfgWithExt := defaultConfig()
	cfgWithExt.Extensions = []string{"/nonexistent/extension.js"}

	ec := newEventCollector(mgr)
	result, err := mgr.StartSession("hasext", cfgWithExt)
	if err != nil {
		t.Fatalf("second StartSession: %v", err)
	}
	if !result.Existed {
		t.Error("expected Existed=true")
	}

	// Should not have emitted any working_message events (no load attempt)
	workingMsgs := ec.byType("engine_working_message")
	for _, wm := range workingMsgs {
		if strings.Contains(wm.event.EventMessage, "Loading extension") {
			t.Error("should not attempt to load extensions when session already has them")
		}
	}
}

// ---------------------------------------------------------------------------
// CLI turn lifecycle hook tests
// ---------------------------------------------------------------------------

// turnRecorder captures turn_start and turn_end calls for assertion.
type turnRecorder struct {
	mu     sync.Mutex
	starts []int
	ends   []int
}

func (r *turnRecorder) recordStart(n int) {
	r.mu.Lock()
	r.starts = append(r.starts, n)
	r.mu.Unlock()
}

func (r *turnRecorder) recordEnd(n int) {
	r.mu.Lock()
	r.ends = append(r.ends, n)
	r.mu.Unlock()
}

func (r *turnRecorder) getStarts() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]int, len(r.starts))
	copy(out, r.starts)
	return out
}

func (r *turnRecorder) getEnds() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]int, len(r.ends))
	copy(out, r.ends)
	return out
}

// newTurnGroup builds an ExtensionGroup whose turn_start/turn_end hooks
// record into the returned turnRecorder.
func newTurnGroup(rec *turnRecorder) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookTurnStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TurnInfo)
		rec.recordStart(info.TurnNumber)
		return nil, nil
	})
	host.SDK().On(extension.HookTurnEnd, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TurnInfo)
		rec.recordEnd(info.TurnNumber)
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

func TestFireCliTurnHooks_TextChunkStartsTurn(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn1")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn1": s}
	mgr.mu.Unlock()

	// First text chunk should fire turn_start(1)
	mgr.fireCliTurnHooks(s, "turn1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hello"},
	})

	starts := rec.getStarts()
	if len(starts) != 1 || starts[0] != 1 {
		t.Errorf("expected turn_start(1), got %v", starts)
	}

	// Second text chunk in same turn should NOT fire again
	mgr.fireCliTurnHooks(s, "turn1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: " world"},
	})

	starts = rec.getStarts()
	if len(starts) != 1 {
		t.Errorf("expected exactly 1 turn_start, got %d", len(starts))
	}
}

func TestFireCliTurnHooks_ToolCallStartsTurn(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn2")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn2": s}
	mgr.mu.Unlock()

	mgr.fireCliTurnHooks(s, "turn2", true, types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1"},
	})

	starts := rec.getStarts()
	if len(starts) != 1 || starts[0] != 1 {
		t.Errorf("expected turn_start(1), got %v", starts)
	}
}

func TestFireCliTurnHooks_TaskUpdateEndsTurn(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn3")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn3": s}
	mgr.mu.Unlock()

	// Start turn 1
	mgr.fireCliTurnHooks(s, "turn3", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hi"},
	})

	// End turn 1 via TaskUpdateEvent (assistant message complete)
	mgr.fireCliTurnHooks(s, "turn3", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	ends := rec.getEnds()
	if len(ends) != 1 || ends[0] != 1 {
		t.Errorf("expected turn_end(1), got %v", ends)
	}
}

func TestFireCliTurnHooks_MultiTurnSequence(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn4")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn4": s}
	mgr.mu.Unlock()

	// Turn 1: text → assistant
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn 1 text"},
	})
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	// Turn 2: tool_call → tool text → assistant
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Bash", ToolID: "t2"},
	})
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn 2 text"},
	})
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	// Turn 3: text → result (final)
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn 3 final"},
	})
	mgr.fireCliTurnHooks(s, "turn4", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	starts := rec.getStarts()
	ends := rec.getEnds()

	if len(starts) != 3 {
		t.Fatalf("expected 3 turn_starts, got %d: %v", len(starts), starts)
	}
	if len(ends) != 3 {
		t.Fatalf("expected 3 turn_ends, got %d: %v", len(ends), ends)
	}
	for i, expected := range []int{1, 2, 3} {
		if starts[i] != expected {
			t.Errorf("turn_start[%d] = %d, want %d", i, starts[i], expected)
		}
		if ends[i] != expected {
			t.Errorf("turn_end[%d] = %d, want %d", i, ends[i], expected)
		}
	}
}

func TestFireCliTurnHooks_TaskCompleteClosesActiveTurn(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn5")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn5": s}
	mgr.mu.Unlock()

	// Start turn but don't send TaskUpdate — go straight to TaskComplete
	mgr.fireCliTurnHooks(s, "turn5", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "only turn"},
	})
	mgr.fireCliTurnHooks(s, "turn5", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	starts := rec.getStarts()
	ends := rec.getEnds()

	if len(starts) != 1 {
		t.Errorf("expected 1 turn_start, got %d", len(starts))
	}
	if len(ends) != 1 {
		t.Errorf("expected 1 turn_end, got %d", len(ends))
	}
}

func TestFireCliTurnHooks_NoopForNonCliBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	s := newCliSession("mock2")

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"mock2": s}
	mgr.mu.Unlock()

	mgr.fireCliTurnHooks(s, "mock2", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hi"},
	})

	if len(rec.getStarts()) != 0 {
		t.Error("should not fire turn hooks for non-CLI backend")
	}
}

func TestFireCliTurnHooks_NoopWithoutExtGroup(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("turn6")
	// No extGroup set

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"turn6": s}
	mgr.mu.Unlock()

	// Should not panic or fire anything
	mgr.fireCliTurnHooks(s, "turn6", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hi"},
	})

	if s.cliTurnNumber != 0 {
		t.Errorf("expected turn counter to stay 0 without extGroup, got %d", s.cliTurnNumber)
	}
}

// ---------------------------------------------------------------------------
// Integration test: handleNormalizedEvent → fireCliTurnHooks
// ---------------------------------------------------------------------------

// TestHandleNormalizedEvent_TaskUpdateFiresTurnEnd verifies that TaskUpdateEvent
// (which has no EngineEvent translation) still triggers turn_end when routed
// through the full handleNormalizedEvent path. This is the regression test for
// the bug where fireCliTurnHooks was placed after the ee.Type == "" early return.
func TestHandleNormalizedEvent_TaskUpdateFiresTurnEnd(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)

	s := newCliSession("hn1")
	s.requestID = "run-1"

	rec := &turnRecorder{}
	s.extGroup = newTurnGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"hn1": s}
	mgr.mu.Unlock()

	// Emit events through handleNormalizedEvent (full path)
	mgr.handleNormalizedEvent("run-1", types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hello"},
	})
	mgr.handleNormalizedEvent("run-1", types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	starts := rec.getStarts()
	ends := rec.getEnds()

	if len(starts) != 1 || starts[0] != 1 {
		t.Errorf("expected turn_start(1) via handleNormalizedEvent, got %v", starts)
	}
	if len(ends) != 1 || ends[0] != 1 {
		t.Errorf("expected turn_end(1) via handleNormalizedEvent, got %v", ends)
	}
}

// ---------------------------------------------------------------------------
// wireAgentToolServer tests
// ---------------------------------------------------------------------------

func TestWireAgentToolServer_RegistersToolForCliBackend(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("agent-ts1")

	mgr.mu.Lock()
	mgr.sessions["agent-ts1"] = s
	mgr.mu.Unlock()

	opts := types.RunOptions{}
	mgr.wireAgentToolServer(s, "agent-ts1", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	if ts == nil {
		t.Fatal("expected ToolServer to be created")
	}
	if opts.McpConfig == "" {
		t.Error("expected McpConfig to be set")
	}

	// Cleanup
	ts.Stop()
}

func TestWireAgentToolServer_NoopForNonCliBackend(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	s := newCliSession("agent-ts2")

	opts := types.RunOptions{}
	mgr.wireAgentToolServer(s, "agent-ts2", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	if ts != nil {
		t.Error("expected no ToolServer for non-CLI backend")
	}
	if opts.McpConfig != "" {
		t.Error("expected no McpConfig for non-CLI backend")
	}
}

func TestWireAgentToolServer_ReusesExistingToolServer(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("agent-ts3")

	// Pre-create a ToolServer (as wireToolServer would)
	existingTS := backend.NewToolServer("agent-ts3")
	if err := existingTS.Start(); err != nil {
		t.Fatalf("failed to start existing ToolServer: %v", err)
	}
	mgr.mu.Lock()
	s.toolServer = existingTS
	mgr.sessions["agent-ts3"] = s
	mgr.mu.Unlock()

	opts := types.RunOptions{}
	mgr.wireAgentToolServer(s, "agent-ts3", &opts)

	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()

	// Should be the same ToolServer instance
	if ts != existingTS {
		t.Error("expected wireAgentToolServer to reuse existing ToolServer")
	}

	// McpConfig should NOT be set again (it was already set by wireToolServer)
	if opts.McpConfig != "" {
		t.Error("expected McpConfig not to be overwritten when ToolServer already exists")
	}

	// Cleanup
	existingTS.Stop()
}

func TestWireAgentToolServer_SpecResolution(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("agent-ts4")

	// Register an agent spec
	s.agents.RegisterSpec(types.AgentSpec{
		Name:         "researcher",
		Model:        "test-model",
		SystemPrompt: "You are a researcher.",
		Tools:        []string{"Read", "Grep"},
	})

	mgr.mu.Lock()
	mgr.sessions["agent-ts4"] = s
	mgr.mu.Unlock()

	// Build the handler directly and test spec resolution
	handler := mgr.buildAgentToolHandler(s, "agent-ts4")

	// Test with unknown spec name
	result, err := handler(map[string]interface{}{
		"prompt": "test task",
		"name":   "nonexistent",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error for unregistered agent name")
	}
	if !strings.Contains(result.Content, "not registered") {
		t.Errorf("expected 'not registered' error, got %q", result.Content)
	}

	// Test with missing prompt
	result, err = handler(map[string]interface{}{
		"name": "researcher",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error for missing prompt")
	}
	if !strings.Contains(result.Content, "prompt is required") {
		t.Errorf("expected 'prompt is required' error, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// message_update hook tests — verify TextChunkEvent accumulation fires
// FireMessageUpdate with the correct content on turn end.
// ---------------------------------------------------------------------------

// msgRecorder captures message_update hook payloads.
type msgRecorder struct {
	mu   sync.Mutex
	msgs []extension.MessageUpdateInfo
}

func (r *msgRecorder) get() []extension.MessageUpdateInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]extension.MessageUpdateInfo, len(r.msgs))
	copy(out, r.msgs)
	return out
}

// newMsgUpdateGroup builds an ExtensionGroup whose message_update hook
// records into the returned msgRecorder.
func newMsgUpdateGroup(rec *msgRecorder) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookMessageUpdate, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.MessageUpdateInfo)
		rec.mu.Lock()
		rec.msgs = append(rec.msgs, info)
		rec.mu.Unlock()
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

func TestFireCliTurnHooks_MessageUpdateAccumulation(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("mu1")

	rec := &msgRecorder{}
	s.extGroup = newMsgUpdateGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"mu1": s}
	mgr.mu.Unlock()

	// Simulate three text chunks then a TaskUpdate (turn end).
	mgr.fireCliTurnHooks(s, "mu1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "Hello"},
	})
	mgr.fireCliTurnHooks(s, "mu1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: ", "},
	})
	mgr.fireCliTurnHooks(s, "mu1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "world!"},
	})
	mgr.fireCliTurnHooks(s, "mu1", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	msgs := rec.get()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message_update, got %d", len(msgs))
	}
	if msgs[0].Role != "assistant" {
		t.Errorf("expected role=assistant, got %q", msgs[0].Role)
	}
	if msgs[0].Content != "Hello, world!" {
		t.Errorf("expected accumulated content 'Hello, world!', got %q", msgs[0].Content)
	}
}

func TestFireCliTurnHooks_MessageUpdateOnTaskComplete(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("mu2")

	rec := &msgRecorder{}
	s.extGroup = newMsgUpdateGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"mu2": s}
	mgr.mu.Unlock()

	// Text chunks followed by TaskComplete (skipping TaskUpdate).
	mgr.fireCliTurnHooks(s, "mu2", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "final answer"},
	})
	mgr.fireCliTurnHooks(s, "mu2", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	msgs := rec.get()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message_update on TaskComplete, got %d", len(msgs))
	}
	if msgs[0].Content != "final answer" {
		t.Errorf("expected 'final answer', got %q", msgs[0].Content)
	}
}

func TestFireCliTurnHooks_NoMessageUpdateWithoutText(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("mu3")

	rec := &msgRecorder{}
	s.extGroup = newMsgUpdateGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"mu3": s}
	mgr.mu.Unlock()

	// Tool call (starts turn) → TaskUpdate (ends turn) with NO text chunks.
	mgr.fireCliTurnHooks(s, "mu3", true, types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Bash", ToolID: "t1"},
	})
	mgr.fireCliTurnHooks(s, "mu3", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	msgs := rec.get()
	if len(msgs) != 0 {
		t.Errorf("expected no message_update when no text was accumulated, got %d", len(msgs))
	}
}

func TestFireCliTurnHooks_MultiTurnMessageUpdate(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("mu4")

	rec := &msgRecorder{}
	s.extGroup = newMsgUpdateGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"mu4": s}
	mgr.mu.Unlock()

	// Turn 1
	mgr.fireCliTurnHooks(s, "mu4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn one"},
	})
	mgr.fireCliTurnHooks(s, "mu4", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	// Turn 2
	mgr.fireCliTurnHooks(s, "mu4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn two"},
	})
	mgr.fireCliTurnHooks(s, "mu4", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	msgs := rec.get()
	if len(msgs) != 2 {
		t.Fatalf("expected 2 message_updates (one per turn), got %d", len(msgs))
	}
	if msgs[0].Content != "turn one" {
		t.Errorf("turn 1 content = %q, want 'turn one'", msgs[0].Content)
	}
	if msgs[1].Content != "turn two" {
		t.Errorf("turn 2 content = %q, want 'turn two'", msgs[1].Content)
	}
}
